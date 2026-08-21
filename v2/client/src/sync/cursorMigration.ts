import type { SyncStateRepository } from '../repositories/syncState';

/**
 * 同期カーソルの一度きりのリセット(#191)。
 *
 * **なぜ必要か。** #182 以前のコードは、暗号化された差分を `parseSyncFile` に通らない
 * 「壊れたblob」として読み飛ばした上で、**カーソルを進めていた**:
 *
 * ```ts
 * const parsed = parseSyncFile(raw);
 * if (!parsed.ok) { skippedBlobs++; continue; }  // 暗号化エンベロープはここで落ちる
 * ...
 * await deps.syncStateRepo.setCursor(maxSeqInBatch);  // ← 進んでしまう
 * ```
 *
 * 一部のblobが読めた場合でも `else` 側のトランザクション内で同じく `setCursor` が呼ばれるため、
 * 「バッチ全部が読めなかった時だけ」ではなく**常に**進む。
 *
 * #182 以降は復号できない差分でカーソルを進めない設計にしたが、**旧版で既に進んでしまった
 * カーソルは戻らない**。そのため更新後も、その間に他端末が上げた差分を永久に取りこぼす——
 * 「同期は成功と表示されるのに相手のノートが来ない」という、利用者から原因の見えない状態になる。
 *
 * **対処。** 更新後の初回起動で一度だけカーソルを0へ戻し、サーバー上の差分を読み直させる。
 * マージは冪等(`mergeSnapshot`)なので、既に取り込み済みの差分を再度取り込んでも結果は変わらない。
 * 代償は一度きりの全件再取得だけ。
 *
 * 一度きりの移行という形は `lib/legacyPaymentMigration.ts` と揃えてある。旧バージョンからの
 * 更新経路が無くなった時点で、このファイルごと削除してよい。
 */

/**
 * 実施済みの印。`it-index-v2:` 接頭辞に揃えてあるため、オールクリア
 * (`lib/factoryReset.ts`)で一緒に消える——消えても実害は無い。オールクリア直後は
 * DBごと初期化されておりカーソルは0なので、次回の実行は何もしないで終わる。
 */
const MIGRATION_FLAG_KEY = 'it-index-v2:sync-cursor-reset-182';

export interface CursorMigrationResult {
  /** この起動で実際にカーソルを戻したか(戻した場合、次の同期で全件を読み直す) */
  reset: boolean;
  /** 戻す前のカーソル値。reset:falseなら0 */
  previousCursor: number;
}

/**
 * 未実施ならカーソルを0へ戻し、実施済みの印を付ける。2回目以降は何もしない。
 *
 * **カーソルが0の端末(新規インストール)でも印だけは付ける。** 付けずに戻ると、
 * 起動のたびに `getCursor()` を読みに行くだけの処理が残り続けるため。
 */
export async function resetSyncCursorOnce(
  syncStateRepo: SyncStateRepository,
): Promise<CursorMigrationResult> {
  if (localStorage.getItem(MIGRATION_FLAG_KEY) !== null) {
    return { reset: false, previousCursor: 0 };
  }

  const previousCursor = await syncStateRepo.getCursor();
  if (previousCursor > 0) {
    await syncStateRepo.setCursor(0);
  }

  // 印はカーソルを戻した後に付ける。逆順だと、間で失敗した場合に
  // 「印だけ付いてカーソルは進んだまま」という直しようのない状態になる
  localStorage.setItem(MIGRATION_FLAG_KEY, String(Date.now()));

  return { reset: previousCursor > 0, previousCursor };
}
