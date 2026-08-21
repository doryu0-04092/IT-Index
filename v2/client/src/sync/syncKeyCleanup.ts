import { deleteSyncBlobs } from './apiClient';

/**
 * 鍵を受け取った後の「古い差分の後始末」を、失敗しても取り落とさないようにする仕組み。
 *
 * **なぜ必要か。** 鍵を受け取る端末は、それ以前に「自分で作った鍵」でpushしている場合がある。
 * 鍵を上書きするとその差分が**誰にも復号できない孤児**になり、**相手端末のカーソルが
 * そこで永久に止まる**。そのため鍵の採用時にサーバー上の差分を消しているが、
 * **この削除が失敗した場合の歯止めが無かった**——案内は出るが、利用者が読まずに同期すると
 * 孤児が残ったままで相手が止まる。
 *
 * **単に「同期させない」では直らない。** 孤児blobで止まるのは**相手の端末**であって
 * こちらではない。こちらの同期を止めても相手は救われないので、
 * **削除をやり直して実際に消すこと**が対処になる。
 *
 * そこで自動pushの write-ahead(#179 `sync/pendingPush.ts`)と同じ形にする:
 * 削除を試みる**前**に印を永続化し、成功が確認できた時だけ消す。失敗・クラッシュでは印が残り、
 * 起動時・オンライン復帰時・同期の直前に拾われて再試行される。
 *
 * 印は `it-index-v2:` 接頭辞に揃えてあるため、オールクリア(`lib/factoryReset.ts`)で
 * 一緒に消える——消えても実害は無い(データごと初期化されるため、消すべき差分も無くなる)。
 */

const PENDING_PREFIX = 'it-index-v2:sync-blob-cleanup-pending:';

function pendingKey(accountId: string): string {
  return `${PENDING_PREFIX}${accountId}`;
}

/** 削除を試みる前に印を付ける。**必ず削除の前に呼ぶこと**(write-ahead) */
export function markBlobCleanupPending(accountId: string): void {
  localStorage.setItem(pendingKey(accountId), String(Date.now()));
}

/** 後始末が終わっていない状態か。画面の警告と再試行の出し分けに使う */
export function isBlobCleanupPending(accountId: string): boolean {
  return localStorage.getItem(pendingKey(accountId)) !== null;
}

export function clearBlobCleanupPending(accountId: string): void {
  localStorage.removeItem(pendingKey(accountId));
}

/**
 * 印が残っていればサーバー上の差分を消し直す。**成功した時だけ印を消す。**
 *
 * @returns 後始末が完了している(元から印が無い場合を含む)なら true
 */
export async function runPendingBlobCleanup(accountId: string, token: string): Promise<boolean> {
  if (!isBlobCleanupPending(accountId)) return true;

  try {
    await deleteSyncBlobs(token);
  } catch {
    // 失敗は握りつぶす——印が残るので次の契機で再試行される。
    // 起動時にも走るため、ここでエラーを出すと押していないのに毎回出ることになる
    return false;
  }

  clearBlobCleanupPending(accountId);
  return true;
}
