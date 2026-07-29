/**
 * ブラウザの WebAuthn API を直接叩く層。実際の認証器（Windows Hello / Android生体認証）が
 * 無いと動作を確認できないため、単体テストの対象外（architecture.md §6 の「io」層に相当）。
 * ロジック側（src/keystore/apiKeyStore.ts）はこのインターフェースだけに依存させ、
 * テスト時はフェイク実装を注入する。
 */

import { randomBytes } from './randomBytes';

const PRF_SALT = new TextEncoder().encode('it-index:api-key-v1');

interface PrfExtensionInputs {
  eval: { first: BufferSource };
}
interface PrfExtensionOutputs {
  enabled?: boolean;
  results?: { first: ArrayBuffer };
}

export interface PasskeyRegistration {
  credentialId: ArrayBuffer;
  /** Firefox 等 PRF 非対応環境では false。呼び出し側はセッションのみモードへ落とす */
  prfSupported: boolean;
  /**
   * create() 呼び出し時に `prf.eval` を渡して要求した結果、その場でPRF出力が得られた場合はここに入る
   * （対応ブラウザでは登録の1回の認証儀式だけで完結する）。得られなかった場合は null で、
   * 呼び出し側が改めて getPrfOutput() を呼ぶ（＝2回目の認証儀式が必要になる）。
   * 「保存のたびに認証プロンプトが2回連続で出て、2回目を利用者が見落として失敗する」という
   * 実際の不具合（docs/ui-pc.md バグ8）を減らすための最適化。
   */
  prfOutput: ArrayBuffer | null;
}

export interface WebAuthnClient {
  isAvailable(): boolean;
  registerPasskey(userId: Uint8Array<ArrayBuffer>, userName: string): Promise<PasskeyRegistration>;
  /** ユーザーがキャンセルした場合・PRF非対応の場合は null */
  getPrfOutput(credentialId: ArrayBuffer): Promise<ArrayBuffer | null>;
}

export function createBrowserWebAuthnClient(): WebAuthnClient {
  return {
    isAvailable() {
      return typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined';
    },

    async registerPasskey(userId, userName) {
      // prf.eval をcreate()の時点で渡しておくと、対応ブラウザ（WebAuthn Level 3相当）では
      // 登録と同時にPRF出力まで得られ、直後の get() 呼び出し（＝2回目の認証プロンプト）を
      // 省略できる。非対応ブラウザでは eval 自体は無視され、enabled のみが返る（従来どおり
      // 呼び出し側が getPrfOutput() で改めて取得するフォールバックに自然に落ちる）。
      const extensions: { prf: PrfExtensionInputs } = { prf: { eval: { first: PRF_SALT } } };

      let credential: PublicKeyCredential | null;
      try {
        credential = (await navigator.credentials.create({
          publicKey: {
            rp: { name: 'IT-Index' },
            user: { id: userId, name: userName, displayName: userName },
            challenge: randomBytes(32),
            pubKeyCredParams: [
              { type: 'public-key', alg: -7 }, // ES256
              { type: 'public-key', alg: -257 }, // RS256
            ],
            authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
            extensions: extensions as AuthenticationExtensionsClientInputs,
          },
        })) as PublicKeyCredential | null;
      } catch {
        // navigator.credentials.create() も get() と同様、失敗時は resolve(null) ではなく
        // reject する（キャンセル・タイムアウト等）。ここにtry/catchが無いと、get()側で
        // 一度直した「未捕捉例外として静かに失敗する」不具合（バグ5）と同種の問題が
        // create()側にも残ってしまう。
        throw new Error('パスキーの登録に失敗しました（キャンセルされたか、認証器を利用できませんでした）。');
      }

      if (!credential) throw new Error('パスキーの登録に失敗しました');

      const extResults = credential.getClientExtensionResults() as { prf?: PrfExtensionOutputs };
      const prfOutput = extResults.prf?.results?.first ?? null;
      return {
        credentialId: credential.rawId,
        prfSupported: extResults.prf?.enabled === true || prfOutput !== null,
        prfOutput,
      };
    },

    async getPrfOutput(credentialId) {
      const extensions: { prf: PrfExtensionInputs } = { prf: { eval: { first: PRF_SALT } } };

      let credential: PublicKeyCredential | null;
      try {
        credential = (await navigator.credentials.get({
          publicKey: {
            challenge: randomBytes(32),
            allowCredentials: [{ id: credentialId, type: 'public-key' }],
            userVerification: 'required',
            extensions: extensions as AuthenticationExtensionsClientInputs,
          },
        })) as PublicKeyCredential | null;
      } catch {
        // navigator.credentials.get() は「取得できない」場合に resolve(null) ではなく
        // reject する（ユーザーによるキャンセル・タイムアウト・ユーザー操作（クリック等）を
        // 伴わない自動呼び出しをブラウザが拒否した場合など）。try/catchが無いと、
        // 起動時の自動復元（tryRestore）がここで未捕捉の例外となり、エラー表示すら出せずに
        // 静かに失敗する（実際に報告された不具合）。契約どおり null を返して吸収する。
        return null;
      }

      if (!credential) return null;

      const extResults = credential.getClientExtensionResults() as { prf?: PrfExtensionOutputs };
      return extResults.prf?.results?.first ?? null;
    },
  };
}
