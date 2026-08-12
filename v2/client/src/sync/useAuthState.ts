import { useCallback, useEffect, useState } from 'react';
import { ApiRequestError, fetchMe, login, signup } from './apiClient';
import { clearToken, getToken, setToken } from './tokenStore';

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
  | { status: 'authed'; email: string; token: string; licensed: boolean };

export interface UseAuthStateResult {
  auth: AuthState;
  authError: string | null;
  authBusy: boolean;
  handleAuthSubmit: (mode: 'signup' | 'login', email: string, password: string) => Promise<void>;
  handleLogout: () => void;
  /** 購入・有効化の成功を即時反映するための更新(サーバーへの再確認は行わない) */
  setLicensed: (licensed: boolean) => void;
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
      const me = await fetchMe(token);
      setAuth({ status: 'authed', email: me.email, token, licensed: me.licensed });
    } catch (err) {
      // トークンを破棄するのは401(失効・不正)のときだけ。ネットワーク断・サーバー停止でも
      // 破棄すると、オフラインのたびに再ログインが必要になる(要件定義書§5)。
      if (err instanceof ApiRequestError && err.status === 401) {
        clearToken();
        setAuth({ status: 'anonymous' });
        return;
      }
      // licensedはサーバーに確認できていないため安全側(false)に倒す。次に接続できた時点で
      // 再確認される(この画面の再マウント、または明示の再確認操作)。
      setAuth({ status: 'authed', email: '(オフライン: 次の接続時に確認します)', token, licensed: false });
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
      const me = await fetchMe(result.token);
      setAuth({ status: 'authed', email: me.email, token: result.token, licensed: me.licensed });
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

  return { auth, authError, authBusy, handleAuthSubmit, handleLogout, setLicensed };
}
