import { isSyncTarget, mergeSnapshot, parseSyncFile, type SyncFile } from '@it-index/shared';
import type { NoteRecord } from '@it-index/shared';
import type { ItIndexDB } from '../db';
import type { AsksRepository } from '../repositories/asks';
import type { NoteConflictsRepository } from '../repositories/noteConflicts';
import type { NotesRepository } from '../repositories/notes';
import type { SyncStateRepository } from '../repositories/syncState';
import type { TermsRepository } from '../repositories/terms';
import { pullSyncBlobs, pushSyncBlob } from './apiClient';
import { buildLocalSnapshot } from './localSnapshot';

export interface SyncEngineDeps {
  db: ItIndexDB;
  termsRepo: TermsRepository;
  notesRepo: NotesRepository;
  asksRepo: AsksRepository;
  noteConflictsRepo: NoteConflictsRepository;
  syncStateRepo: SyncStateRepository;
  deviceId: string;
}

/**
 * 送信するノートからnoteHistoryを落とす(v1 ../../../src/sync/syncFile.ts参照)。
 * 履歴は「この端末で上書きする前の版」の積み重ねで、同期対象外の端末ローカルな記録
 * (client/src/repositories/notes.tsのコメント参照)。相手へ送ると相手の履歴が置き換わってしまう。
 */
function stripNoteHistory(notes: NoteRecord[]): NoteRecord[] {
  return notes.map((n) => ({ ...n, noteHistory: [] }));
}

/** リレーへ送るスナップショットの組み立て。terms・notes・asksは全件対象(要件どおり) */
export async function buildOutboundPayload(deps: SyncEngineDeps): Promise<string> {
  const [notes, asks, terms] = await Promise.all([
    deps.notesRepo.getAll(),
    deps.asksRepo.getAllOrdered(),
    deps.termsRepo.getAllForSync(),
  ]);
  const file: SyncFile = {
    syncSchemaVersion: 1,
    deviceId: deps.deviceId,
    writtenAt: Date.now(),
    notes: stripNoteHistory(notes),
    asks,
    aiTerms: terms.filter(isSyncTarget),
  };
  return JSON.stringify(file);
}

export async function pushToRelay(deps: SyncEngineDeps, token: string): Promise<{ seq: number }> {
  const payload = await buildOutboundPayload(deps);
  return pushSyncBlob(token, deps.deviceId, payload);
}

/**
 * マージ結果をterms/notes/asks/noteConflictsへ書き込む。呼び出し側が db.transaction() で
 * 包んだ中で呼ぶこと——このシグネチャ自体は独自のトランザクションを開かない
 * (Dexieはネストしたtransaction()を、対象テーブルが外側の部分集合なら外側へ合流させるが、
 * 呼び出しがtransaction外だと素通しでコミットされてしまい原子性が壊れるため)。
 */
async function applyMergeResult(
  deps: SyncEngineDeps,
  merged: ReturnType<typeof mergeSnapshot>,
  detectedAt: number,
): Promise<number> {
  for (const note of merged.notes) {
    await deps.notesRepo.upsertFromSync(note);
  }
  await deps.asksRepo.upsertFromSync(merged.asks);
  for (const term of merged.terms) {
    await deps.termsRepo.upsertFromSync(term);
  }
  for (const conflict of merged.conflicts) {
    // remote.lastEditedByはその内容を最後に書いた端末(v1の同名コメントと同じ理由。
    // 中継されてきた分でも実際に編集した端末を指す)
    await deps.noteConflictsRepo.add(conflict, conflict.remote.lastEditedBy, detectedAt);
  }
  return merged.conflicts.length;
}

export interface PullOutcome {
  /** 検証に通り取り込んだ他端末ぶんのblob件数 */
  receivedBlobs: number;
  /** 検証に通らずスキップしたblob件数(既存データは保持) */
  skippedBlobs: number;
  /** 新たに記録された競合件数 */
  conflicts: number;
}

/**
 * cursor以降の差分をpullし、決定的マージ→原子的な取り込みを行う。1回のpullが
 * サーバーのページ上限(100件)を返した場合は、latestに達するまで繰り返す。
 *
 * 原子性(要件定義書§5・必達): 関係テーブルへの反映とカーソルの更新を1つの
 * db.transaction()に包む。書き込み中に例外が起きればDexieがトランザクション全体を
 * ロールバックし、この関数もその例外をそのまま呼び出し元へ投げる——cursorは進まない。
 *
 * 検証に通らないblobのスキップは「書き込み失敗」ではなく意図した読み飛ばしのため、
 * ロールバック対象ではない。読み飛ばした分もバッチのcursorには含めて進める
 * (同じ壊れたblobを毎回取得し続けないため。architecture.md §4「壊れたデータ」)。
 */
export async function pullFromRelay(deps: SyncEngineDeps, token: string): Promise<PullOutcome> {
  let cursor = await deps.syncStateRepo.getCursor();
  let receivedBlobs = 0;
  let skippedBlobs = 0;
  let conflicts = 0;

  for (;;) {
    const { blobs, latest } = await pullSyncBlobs(token, cursor);
    if (blobs.length === 0) break;

    const remoteFiles: SyncFile[] = [];
    for (const blob of blobs) {
      if (blob.deviceId === deps.deviceId) continue; // 自端末が送った分は自分の最新状態そのもの

      let raw: unknown;
      try {
        raw = JSON.parse(blob.payload);
      } catch {
        skippedBlobs++;
        continue;
      }
      const parsed = parseSyncFile(raw);
      if (!parsed.ok) {
        skippedBlobs++;
        continue;
      }
      remoteFiles.push(parsed.file);
      receivedBlobs++;
    }

    const maxSeqInBatch = blobs.reduce((max, b) => Math.max(max, b.seq), cursor);
    const now = Date.now();

    if (remoteFiles.length === 0) {
      await deps.syncStateRepo.setCursor(maxSeqInBatch);
    } else {
      const local = await buildLocalSnapshot(deps);
      const merged = mergeSnapshot(local, remoteFiles);

      await deps.db.transaction(
        'rw',
        [deps.db.terms, deps.db.notes, deps.db.asks, deps.db.noteConflicts, deps.db.syncState],
        async () => {
          conflicts += await applyMergeResult(deps, merged, now);
          await deps.syncStateRepo.setCursor(maxSeqInBatch);
        },
      );
    }

    cursor = maxSeqInBatch;
    if (cursor >= latest) break;
  }

  return { receivedBlobs, skippedBlobs, conflicts };
}

export interface ImportV1Outcome {
  imported: boolean;
  /** 取り込み中止時の理由(要件定義書§5.7と同じ原則「検証に通らなければ中止」) */
  reason: string | null;
  conflicts: number;
}

/**
 * v1の手動書き出しJSON(同じSyncFile形式。../../../src/manualSync/参照)を取り込む。
 * pullFromRelay()と同じ検証(parseSyncFile)・同じ決定的マージ(mergeSnapshot)・
 * 同じ原子性(db.transaction)の経路を使う。リレーのcursorには影響しない
 * (relayのseq空間とは無関係な輸送手段のため)。
 */
export async function importV1Snapshot(deps: SyncEngineDeps, raw: string): Promise<ImportV1Outcome> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { imported: false, reason: 'JSONの解析に失敗しました', conflicts: 0 };
  }

  const parsed = parseSyncFile(json);
  if (!parsed.ok) {
    return { imported: false, reason: parsed.reason, conflicts: 0 };
  }

  const local = await buildLocalSnapshot(deps);
  const merged = mergeSnapshot(local, [parsed.file]);
  const now = Date.now();
  let conflicts = 0;

  await deps.db.transaction('rw', [deps.db.terms, deps.db.notes, deps.db.asks, deps.db.noteConflicts], async () => {
    conflicts = await applyMergeResult(deps, merged, now);
  });

  return { imported: true, reason: null, conflicts };
}
