import { ApiRequestError } from './apiClient';
import { runSync, type SyncEngineDeps, type SyncRunResult } from './syncEngine';
import { runPendingBlobCleanup } from './syncKeyCleanup';

/**
 * 起動時の自動受け取り(#193)。
 *
 * **なぜ必要か。** 同期は送る側(push)だけが自動で、受け取る側(pull)は「今すぐ同期」を
 * 押した時にしか走らない非対称な作りだった。相手が自動pushしていても、こちらが押すまで
 * 降りてこないため、**利用者からは片方向にしか進んでいないように見える**
 * (#182の実機確認で実際に報告された)。起動時に一度だけ受け取りも走らせて揃える。
 *
 * **静かに諦める。** 起動のたびに走る処理なので、失敗を画面へ出さない。想定される失敗:
 *
 * - 未ログイン・未ライセンス(403) … 公式ホストでは同期は有償機能。押していないのにエラーが
 *   出るのは筋が通らない
 * - オフライン … 次の起動かオンライン復帰時に改めて走ればよい
 * - 鍵が揃っていない … 復号できない差分はカーソルを進めず保持される(#182)。
 *   利用者が同期タブを開いた時に案内が出るので、起動時に割り込む必要は無い
 *
 * **`runSync` をそのまま使う**(pullだけを切り出さない)。同期の実行記録(syncEvents)と
 * 競合の照合フェーズが `runSync` に閉じているため、pullだけを呼ぶと記録が欠ける。
 * 余分に1回pushすることになるが、送るのは全量スナップショットで冪等なため実害が無い。
 */

export interface AutoPullDeps {
  /** 未ログインならnull */
  token: string | null;
  /** 同期エンジンに渡す一式。deviceId・accountIdが揃っていなければnull */
  syncDeps: SyncEngineDeps | null;
  /** ブラウザがオフラインを申告していればfalse */
  online: boolean;
}

export type AutoPullOutcome =
  | { status: 'skipped'; reason: 'not-authed' | 'not-ready' | 'offline' }
  | { status: 'succeeded'; result: SyncRunResult }
  | { status: 'failed'; reason: 'unlicensed' | 'other' };

/**
 * 条件が揃っていれば同期を1回実行する。**例外は投げない**——呼び出し側は
 * fire-and-forgetでよく、結果は「画面を更新すべきか」の判断だけに使う。
 */
export async function runAutoPull(deps: AutoPullDeps): Promise<AutoPullOutcome> {
  if (!deps.online) return { status: 'skipped', reason: 'offline' };
  if (deps.token === null) return { status: 'skipped', reason: 'not-authed' };
  if (deps.syncDeps === null) return { status: 'skipped', reason: 'not-ready' };

  try {
    // 鍵の受け取り後の後始末が終わっていなければ、同期の前にやり直す(sync/syncKeyCleanup.ts)。
    // 残したまま同期すると、孤児blobで**相手端末のカーソルが止まったまま**になる
    await runPendingBlobCleanup(deps.syncDeps.accountId, deps.token);

    const result = await runSync(deps.syncDeps, deps.token);
    return { status: 'succeeded', result };
  } catch (err) {
    // 未ライセンス(403)は「使えない」であって異常ではない。他の失敗と区別はするが、
    // どちらも画面には出さない
    if (err instanceof ApiRequestError && err.status === 403) {
      return { status: 'failed', reason: 'unlicensed' };
    }
    return { status: 'failed', reason: 'other' };
  }
}

/**
 * 自動受け取りの結果、画面のデータを読み直すべきか。
 * 受信が0件・統一0件なら何も変わっていないので、無駄な再読込を避ける
 * (手動同期(SyncScreen)の `onSyncApplied` と同じ判定)。
 */
export function shouldRefreshAfterAutoPull(outcome: AutoPullOutcome): boolean {
  return (
    outcome.status === 'succeeded' &&
    (outcome.result.receivedBlobs > 0 || outcome.result.adoptedDecisions > 0)
  );
}
