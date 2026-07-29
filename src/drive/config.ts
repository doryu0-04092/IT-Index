/**
 * Google Cloud Console で発行するOAuthクライアントID（docs/drive-sync.md §2）。
 * 未設定（Google Cloud側の設定がまだの状態）なら null を返す。呼び出し側は
 * null の場合「Drive同期は使えません」の扱いにフォールバックすること。
 */
export function getGoogleClientId(): string | null {
  const value = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  return value && value.trim() !== '' ? value : null;
}
