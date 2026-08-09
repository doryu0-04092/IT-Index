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
}
