import type { AiProvider } from '../ai/providers/types';
import type { KeyStoreRepository } from '../repositories/keyStore';
import { decryptApiKey, deriveAesKeyFromPrfOutput, encryptApiKey } from './crypto';
import { randomBytes } from './randomBytes';
import type { WebAuthnClient } from './webauthn';

export interface AiCredential {
  provider: AiProvider;
  apiKey: string;
  model: string;
}

/**
 * セッション中のみのメモリ保持（docs/requirements.md §5.6 層3・既定の状態）。
 * モジュールスコープの変数なのでタブを閉じれば消える。
 * プロバイダ・モデルもキーとセットで持つ（プロバイダごとにAPIキーの形式・呼び出し先が違うため）。
 */
let sessionCredential: AiCredential | null = null;

export function setSessionCredential(credential: AiCredential): void {
  sessionCredential = credential;
}

export function getSessionCredential(): AiCredential | null {
  return sessionCredential;
}

export function clearSessionCredential(): void {
  sessionCredential = null;
}

export interface ApiKeyStore {
  /** WebAuthn自体が使える環境か。PRF対応かどうかは enablePersistence を実行するまで分からない */
  isPersistenceAvailable(): boolean;
  /**
   * 保存済みの資格情報が存在するか（復号はしない。存在確認だけなのでWebAuthnを要さない）。
   * 起動直後に「パスキーで認証」ボタンを出すかどうかの判定に使う。
   */
  hasPersistedCredential(): Promise<boolean>;
  /** 明示的なオプトイン。パスキーに紐付けて暗号化保存し、同時にセッションにも載せる */
  enablePersistence(credential: AiCredential): Promise<void>;
  /**
   * 保存済みならWebAuthnで復号してセッションに載せる。無ければ何もせず false。
   * navigator.credentials.get() はユーザー操作（クリック等）を伴わない自動呼び出しを
   * ブラウザに拒否されることがあるため、**ユーザーの明示的な操作（ボタン押下）の中で呼ぶこと**
   * （ページ読み込み直後に自動で呼んでも失敗しやすい。実際に報告された不具合）。
   */
  tryRestore(): Promise<boolean>;
  disablePersistence(): Promise<void>;
}

export function createApiKeyStore(keyStoreRepo: KeyStoreRepository, webauthn: WebAuthnClient): ApiKeyStore {
  return {
    isPersistenceAvailable() {
      return webauthn.isAvailable();
    },

    async hasPersistedCredential() {
      const record = await keyStoreRepo.get();
      return record !== undefined;
    },

    async enablePersistence(credential) {
      if (!webauthn.isAvailable()) {
        throw new Error('この環境ではパスキーが使えないため保存できません');
      }

      const userId = randomBytes(16);
      const {
        credentialId,
        prfSupported,
        prfOutput: prfOutputFromCreate,
      } = await webauthn.registerPasskey(userId, 'it-index-device');
      if (!prfSupported) {
        throw new Error('この環境は PRF 拡張に対応していないため保存できません（Firefox 等）');
      }

      // 対応ブラウザでは registerPasskey() の時点でPRF出力を直接得られている（1回の認証儀式で完結）。
      // 得られなかった場合のみ、フォールバックとして改めて取得する（＝利用者に2回目の認証プロンプトが出る。
      // 実際に報告された不具合。docs/ui-pc.md バグ8）。
      const prfOutput = prfOutputFromCreate ?? (await webauthn.getPrfOutput(credentialId));
      if (!prfOutput) {
        throw new Error(
          '鍵の導出に失敗しました。パスキー自体の登録は完了している可能性があります。もう一度お試しいただくか、設定画面から状態をご確認ください。',
        );
      }

      const aesKey = await deriveAesKeyFromPrfOutput(prfOutput);
      const { ciphertext, iv } = await encryptApiKey(aesKey, credential.apiKey);

      await keyStoreRepo.put({ provider: credential.provider, model: credential.model, credentialId, ciphertext, iv });
      setSessionCredential(credential);
    },

    async tryRestore() {
      const record = await keyStoreRepo.get();
      if (!record) return false;
      if (!webauthn.isAvailable()) return false;

      const prfOutput = await webauthn.getPrfOutput(record.credentialId);
      if (!prfOutput) return false; // キャンセル or 非対応

      const aesKey = await deriveAesKeyFromPrfOutput(prfOutput);
      const apiKey = await decryptApiKey(aesKey, { ciphertext: record.ciphertext, iv: record.iv });
      setSessionCredential({ provider: record.provider, model: record.model, apiKey });
      return true;
    },

    async disablePersistence() {
      await keyStoreRepo.clear();
    },
  };
}
