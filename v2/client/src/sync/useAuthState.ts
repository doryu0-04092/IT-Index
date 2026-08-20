import { useCallback, useEffect, useState } from 'react';
import {
  ApiRequestError,
  fetchMe,
  login,
  savePaymentMethod,
  signup,
  type MeResponse,
  type PaymentMethod,
} from './apiClient';
import {
  clearLegacyPaymentKeys,
  hasLegacyPaymentKeys,
  readLegacyPaymentMethod,
} from '../lib/legacyPaymentMigration';
import { clearToken, getToken, setAccountId, setToken } from './tokenStore';

/**
 * ログイン状態(SyncScreen.tsxから抽出。設定タブ(ライセンスのログイン誘導)と共有するため。
 * licensedは/api/auth/meが返す値をそのまま持つ(要件定義書§4「提供形態」。公式ホストで
 * 同期・共有AIを使えるかを表す1つの値。セルフホストでは常にtrue)。
 *
 * SyncScreen・SettingsScreenはそれぞれ自分でこのhookを呼ぶ(=マウントごとに/api/auth/meを
 * 呼び直す)。App.tsxに認証状態を集約する作りにはしていない——トークン自体は
 * sync/tokenStore.ts(localStorage)が唯一の実体であり、この2画面は元から自分でDBを引き直す
 * 設計(navigation.tsのコメント参照)に揃えた。タブ切替のたびに1回GET /api/auth/meが
 * 増える代わりに、画面間の状態同期(片方でログアウトしたら片方も即時反映、等)を
 * 別途実装する必要が無くなる。
 */
export type AuthState =
  | { status: 'checking' }
  | { status: 'anonymous' }
  | ({
      status: 'authed';
      email: string;
      token: string;
    } & Pick<
      MeResponse,
      'licensed' | 'licenseCode' | 'licenseSource' | 'activatedAt' | 'paymentMethod'
    >);

export interface UseAuthStateResult {
  auth: AuthState;
  authError: string | null;
  authBusy: boolean;
  handleAuthSubmit: (mode: 'signup' | 'login', email: string, password: string) => Promise<void>;
  handleLogout: () => void;
  /** 購入・有効化の成功を即時反映するための更新(サーバーへの再確認は行わない) */
  setLicensed: (licensed: boolean) => void;
  /** カード登録・変更の成功を即時反映する(同上) */
  setPaymentMethod: (method: PaymentMethod) => void;
  /** 解約の成功を即時反映する。ライセンス・コード・カードが同時に無くなる(同上) */
  clearLicense: () => void;
}

/**
 * ライセンスを持たない状態。解約直後の反映と、オフライン時のフォールバックの両方で使う
 * (オフラインはサーバーに確認できていないため、安全側=未ライセンスに倒す)。
 */
const NO_LICENSE_STATE = {
  licensed: false,
  licenseCode: null,
  licenseSource: null,
  activatedAt: null,
  paymentMethod: null,
} as const;

/**
 * 旧バージョンでこの端末に保存されたお支払い方法を、一度だけサーバーへ移してキーを消す。
 * サーバー側に既にカードがある場合はサーバーを正とし、旧キーは移さず捨てるだけ
 * (二重の保存先を残さないことが今回の修正の要のため)。
 * 移送に失敗しても旧キーは残し、次回の起動で再試行する。
 */
async function migrateLegacyPaymentMethod(token: string, me: MeResponse): Promise<MeResponse> {
  if (!hasLegacyPaymentKeys()) return me;

  const legacy = me.paymentMethod === null ? readLegacyPaymentMethod() : null;
  if (legacy === null || !me.licensed) {
    clearLegacyPaymentKeys();
    return me;
  }

  try {
    const saved = await savePaymentMethod(token, legacy);
    clearLegacyPaymentKeys();
    return { ...me, paymentMethod: saved.paymentMethod };
  } catch {
    return me;
  }
}

export function useAuthState(): UseAuthStateResult {
  const [auth, setAuth] = useState<AuthState>({ status: 'checking' });
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

  // マウント時: 保存済みトークンがあれば有効性を/api/auth/meで確認する
  // (期限切れ・失効時はログイン画面へ戻す)。useAppInit.tsのrunSeedImportと同じ理由で
  // 最初にawait Promise.resolve()を置き、effect内の同期的なsetState呼び出しから切り離す。
  const checkAuth = useCallback(async () => {
    await Promise.resolve();
    const token = getToken();
    if (!token) {
      setAuth({ status: 'anonymous' });
      return;
    }
    try {
      const me = await migrateLegacyPaymentMethod(token, await fetchMe(token));
      // 同期の暗号鍵はアカウント単位で保管する(#182)。画面の外から動く自動push(App.tsx)も
      // 引けるよう、トークンと同じくlocalStorageへ書く
      setAccountId(me.accountId);
      setAuth({ status: 'authed', token, ...meFields(me) });
    } catch (err) {
      // トークンを破棄するのは401(失効・不正)のときだけ。ネットワーク断・サーバー停止でも
      // 破棄すると、オフラインのたびに再ログインが必要になる(要件定義書§5)。
      if (err instanceof ApiRequestError && err.status === 401) {
        clearToken();
        setAuth({ status: 'anonymous' });
        return;
      }
      // 次に接続できた時点で再確認される(この画面の再マウント、または明示の再確認操作)。
      setAuth({
        status: 'authed',
        email: '(オフライン: 次の接続時に確認します)',
        token,
        ...NO_LICENSE_STATE,
      });
    }
  }, []);

  useEffect(() => {
    // マウント時のトークン確認は、ユーザー操作に紐づくイベントハンドラが存在しない
    // 起動時副作用であり、effectで行うのが正しい(useAppInit.tsの同種コメント参照)。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void checkAuth();
  }, [checkAuth]);

  async function handleAuthSubmit(mode: 'signup' | 'login', email: string, password: string) {
    setAuthBusy(true);
    setAuthError(null);
    try {
      const result = mode === 'signup' ? await signup(email, password) : await login(email, password);
      setToken(result.token);
      const me = await migrateLegacyPaymentMethod(result.token, await fetchMe(result.token));
      setAccountId(me.accountId);
      setAuth({ status: 'authed', token: result.token, ...meFields(me) });
    } catch (err) {
      setAuthError(err instanceof ApiRequestError ? err.message : 'サーバーに接続できませんでした');
    } finally {
      setAuthBusy(false);
    }
  }

  function handleLogout() {
    clearToken();
    setAuth({ status: 'anonymous' });
  }

  const setLicensed = useCallback((licensed: boolean) => {
    setAuth((prev) => (prev.status === 'authed' ? { ...prev, licensed } : prev));
  }, []);

  const setPaymentMethod = useCallback((paymentMethod: PaymentMethod) => {
    setAuth((prev) => (prev.status === 'authed' ? { ...prev, paymentMethod } : prev));
  }, []);

  const clearLicense = useCallback(() => {
    setAuth((prev) =>
      prev.status === 'authed' ? { ...prev, ...NO_LICENSE_STATE } : prev
    );
  }, []);

  return {
    auth,
    authError,
    authBusy,
    handleAuthSubmit,
    handleLogout,
    setLicensed,
    setPaymentMethod,
    clearLicense,
  };
}

/** /api/auth/meの応答からAuthStateが持つ項目だけを取り出す */
function meFields(me: MeResponse) {
  return {
    email: me.email,
    licensed: me.licensed,
    licenseCode: me.licenseCode,
    licenseSource: me.licenseSource,
    activatedAt: me.activatedAt,
    paymentMethod: me.paymentMethod,
  };
}
