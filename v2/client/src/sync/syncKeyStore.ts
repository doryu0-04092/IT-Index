import { generateDataKey } from './syncCrypto';

/**
 * 同期データ鍵(DK)の端末内保管(#182)。
 *
 * `sync/apiKeyStore.ts`・`sync/tokenStore.ts`・`sync/serverConfig.ts` と同じ流儀で
 * localStorage にキー名固定で置く。接頭辞を `it-index-v2:` に揃えてあるため、
 * オールクリア(`lib/factoryReset.ts` が接頭辞一致で一括削除する)にも自動で追随する。
 *
 * **鍵はアカウント単位で分ける。** 同じ端末で別のアカウントにログインした時に前の鍵を
 * 使い回すと、相手の暗号文を自分の鍵で復号しようとして失敗し続ける(しかも原因が見えない)。
 * キー名に accountId を含めることで、アカウントを切り替えれば自然に別の鍵になる。
 *
 * この値はサーバーに保存されない。渡す時だけ、QR(サーバー非経由)か
 * 8桁コードで包んだ形(5分だけ預ける)でもう一方の端末へ渡す。
 */

const KEY_PREFIX = 'it-index-v2:sync-data-key:';

function storageKey(accountId: string): string {
  return `${KEY_PREFIX}${accountId}`;
}

/** 保存済みの鍵(base64url)。未設定ならnull */
export function getDataKey(accountId: string): string | null {
  const raw = localStorage.getItem(storageKey(accountId));
  return raw === null || raw === '' ? null : raw;
}

export function setDataKey(accountId: string, dataKey: string): void {
  localStorage.setItem(storageKey(accountId), dataKey);
}

export function clearDataKey(accountId: string): void {
  localStorage.removeItem(storageKey(accountId));
}

/**
 * 鍵が無ければ作って保存し、あればそれを返す。
 *
 * **最初にpushする端末がここで鍵を作る。** 2台目は「復号できない差分が届く」ことで
 * 鍵が揃っていないと分かるので、そこで受け渡しへ誘導する(SyncScreen)。
 * 先に鍵の受け渡しを済ませていなくても同期を始められるようにするための入口。
 */
export function getOrCreateDataKey(accountId: string): string {
  const existing = getDataKey(accountId);
  if (existing !== null) return existing;

  const created = generateDataKey();
  setDataKey(accountId, created);
  return created;
}

/**
 * 鍵を作り直す(全端末の鍵を失った時の復旧導線)。
 * 呼び出し側はこの後、サーバー上の差分を消して全端末で再pushさせる必要がある——
 * 古い鍵で暗号化された差分は誰にも復号できないため、残しても読めないまま溜まる。
 */
export function regenerateDataKey(accountId: string): string {
  const created = generateDataKey();
  setDataKey(accountId, created);
  return created;
}
