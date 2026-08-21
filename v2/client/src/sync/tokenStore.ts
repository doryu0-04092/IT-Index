/**
 * 認証トークンの端末内保存。localStorageに保存する(要件どおり。キー名固定)。
 * SyncScreenがログイン状態を判定する唯一の入力源にする(存在すればログイン済み扱い)。
 */
const TOKEN_KEY = 'it-index-v2:token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ACCOUNT_ID_KEY);
}

/**
 * ログイン中のアカウントID(#182)。トークンと**同じ寿命**なのでここに併置する
 * (ログイン時に書き、ログアウト・失効時にトークンごと消える)。
 *
 * 同期データの暗号鍵をアカウント単位で保管するために要る(sync/syncKeyStore.ts)。
 * Reactの状態(useAuthState)だけに持たせると、画面の外から動く自動push(App.tsx)が
 * 鍵を引けないため、トークンと同じくlocalStorageを唯一の入力源にする。
 */
const ACCOUNT_ID_KEY = 'it-index-v2:account-id';

export function getAccountId(): string | null {
  const raw = localStorage.getItem(ACCOUNT_ID_KEY);
  return raw === null || raw === '' ? null : raw;
}

export function setAccountId(accountId: string): void {
  localStorage.setItem(ACCOUNT_ID_KEY, accountId);
}
