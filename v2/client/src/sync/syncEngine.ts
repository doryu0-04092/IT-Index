import {
  isSameContent,
  isSyncTarget,
  mergeSnapshot,
  parseSyncFile,
  type MergeOptions,
  type SyncFile,
} from '@it-index/shared';
import type { NoteRecord } from '@it-index/shared';
import type { ItIndexDB } from '../db';
import type { AsksRepository } from '../repositories/asks';
import type { NoteConflictsRepository } from '../repositories/noteConflicts';
import type { NotesRepository } from '../repositories/notes';
import type { SyncEventsRepository } from '../repositories/syncEvents';
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
  syncEventsRepo: SyncEventsRepository;
  syncStateRepo: SyncStateRepository;
  deviceId: string;
  /**
   * true(Androidネイティブ)なら競合時にlocalを保持し、相手側(PC)の決定が届いたときだけ
   * 採用する(#157。shared/core/mergeSnapshot.ts MergeOptions参照)。falseなら従来の
   * newest-wins+競合記録(PC=解消する側)。
   */
  holdLocalOnConflict: boolean;
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
  syncEventId: string,
): Promise<number> {
  // 相手側(PC)の決定として採用するtermId(holdLocalOnConflict時のみ非空)。
  // 通常のupsertFromSyncと違い、保持していた自分の版をnoteHistoryへ退避してから採用する
  const peerDecisionTermIds = new Set(merged.peerDecisions.map((d) => d.termId));

  for (const note of merged.notes) {
    if (peerDecisionTermIds.has(note.termId)) {
      await deps.notesRepo.adoptPeerDecision(note);
    } else {
      await deps.notesRepo.upsertFromSync(note);
    }
  }
  await deps.asksRepo.upsertFromSync(merged.asks);
  for (const term of merged.terms) {
    await deps.termsRepo.upsertFromSync(term);
  }

  let conflictCount = 0;
  for (const conflict of merged.conflicts) {
    // remote.lastEditedByはその内容を最後に書いた端末(v1の同名コメントと同じ理由。
    // 中継されてきた分でも実際に編集した端末を指す)
    const peer = conflict.remote.lastEditedBy;
    // 論理競合1件=open行1件に正規化する(#157)。以前は毎pullで無条件addしていたため、
    // 未解決のまま同期を重ねると同じ語の競合が別レコードとして積み上がっていた
    const existing = await deps.noteConflictsRepo.findOpenByTermAndPeer(conflict.termId, peer);
    if (existing) {
      const contentChanged =
        !isSameContent(existing.local, conflict.local) || !isSameContent(existing.remote, conflict.remote);
      await deps.noteConflictsRepo.refresh(existing.id, {
        local: conflict.local,
        remote: conflict.remote,
        detectedAt,
        syncEventId,
        // 内容が変わっていれば、以前の2版から作ったAI統合キャッシュは古いので破棄する
        resetMerged: contentChanged,
      });
    } else {
      await deps.noteConflictsRepo.add(conflict, peer, detectedAt, syncEventId);
    }
    conflictCount++;
  }

  // 相手側(PC)の決定を採用した競合はクローズする(統一完了)
  for (const decision of merged.peerDecisions) {
    const open = await deps.noteConflictsRepo.findOpenByTermAndPeer(
      decision.termId,
      decision.adopted.lastEditedBy,
    );
    if (open) {
      await deps.noteConflictsRepo.closeAuto(open.id, 'peer-decision', detectedAt);
    }
  }

  return conflictCount;
}

export interface PullOutcome {
  /** 検証に通り取り込んだ他端末ぶんのblob件数 */
  receivedBlobs: number;
  /** 検証に通らずスキップしたblob件数(既存データは保持) */
  skippedBlobs: number;
  /** 今回の同期で検出(新規+再発)された競合件数 */
  conflicts: number;
  /** 相手側(PC)の決定を採用して統一した件数(Androidネイティブのみ非0) */
  adoptedDecisions: number;
  /** 受信して検証に通ったnoteのtermId(照合フェーズのsuperseded判定に使う) */
  receivedTermIds: Set<string>;
  /** 受信して検証に通ったblobのdeviceId(重複除去) */
  peerDeviceIds: Set<string>;
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
export async function pullFromRelay(
  deps: SyncEngineDeps,
  token: string,
  syncEventId: string,
): Promise<PullOutcome> {
  let cursor = await deps.syncStateRepo.getCursor();
  let receivedBlobs = 0;
  let skippedBlobs = 0;
  let conflicts = 0;
  let adoptedDecisions = 0;
  const receivedTermIds = new Set<string>();
  const peerDeviceIds = new Set<string>();

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
      peerDeviceIds.add(parsed.file.deviceId);
      parsed.file.notes.forEach((n) => receivedTermIds.add(n.termId));
    }

    const maxSeqInBatch = blobs.reduce((max, b) => Math.max(max, b.seq), cursor);
    const now = Date.now();

    if (remoteFiles.length === 0) {
      await deps.syncStateRepo.setCursor(maxSeqInBatch);
    } else {
      const local = await buildLocalSnapshot(deps);
      // holdLocal時のbaseline: 未クローズ競合が検出された時点のremote.updatedAt。
      // これより新しいremote版だけを「PC側の決定」として採用する(mergeSnapshot参照)。
      // バッチごとに組み直す——前のバッチで検出された競合が次のバッチの判定に効くため
      let options: MergeOptions | undefined;
      if (deps.holdLocalOnConflict) {
        const open = await deps.noteConflictsRepo.getOpen();
        options = {
          holdLocalOnConflict: true,
          openConflictBaselines: new Map(open.map((c) => [c.termId, c.remote.updatedAt])),
        };
      }
      const merged = mergeSnapshot(local, remoteFiles, options);
      adoptedDecisions += merged.peerDecisions.length;

      await deps.db.transaction(
        'rw',
        [deps.db.terms, deps.db.notes, deps.db.asks, deps.db.noteConflicts, deps.db.syncState],
        async () => {
          conflicts += await applyMergeResult(deps, merged, now, syncEventId);
          await deps.syncStateRepo.setCursor(maxSeqInBatch);
        },
      );
    }

    cursor = maxSeqInBatch;
    if (cursor >= latest) break;
  }

  return { receivedBlobs, skippedBlobs, conflicts, adoptedDecisions, receivedTermIds, peerDeviceIds };
}

export interface SyncRunResult {
  syncEventId: string;
  receivedBlobs: number;
  skippedBlobs: number;
  /** この同期イベントに紐づく競合件数(新規+再発+持ち越し) */
  conflictCount: number;
  /** 相手側(PC)の決定を採用して統一した件数 */
  adoptedDecisions: number;
}

/**
 * 「今すぐ同期」1回分の実行(#157)。push→syncEvent記録→pull→照合フェーズの順で、
 * 同期の実行そのものをsyncEventsに記録し、競合をそのイベントへリンクする。
 *
 * 照合フェーズ(今回検出されなかったopen競合の扱い):
 * - 今回その語のnoteを受信していた(=新鮮なデータで競合が再発しなかった) → superseded でクローズ
 * - 受信していない(相手が同期していないだけ) → 最新イベントへ持ち越し(リストに残す)。
 *   字義どおり消すと未解決の実競合をPCで解消できなくなるため
 */
export async function runSync(deps: SyncEngineDeps, token: string): Promise<SyncRunResult> {
  const syncEventId = crypto.randomUUID();
  const at = Date.now();

  const { seq } = await pushToRelay(deps, token);
  // pullが途中で失敗しても「この同期は始まった」記録は残す(completed:falseが痕跡になる)
  await deps.syncEventsRepo.put({
    id: syncEventId,
    at,
    pushedSeq: seq,
    receivedBlobs: 0,
    skippedBlobs: 0,
    conflictCount: 0,
    peerDeviceIds: [],
    completed: false,
  });

  const pulled = await pullFromRelay(deps, token, syncEventId);

  await deps.db.transaction('rw', [deps.db.noteConflicts, deps.db.syncEvents], async () => {
    const now = Date.now();
    const open = await deps.noteConflictsRepo.getOpen();
    for (const conflict of open) {
      if (conflict.syncEventId === syncEventId) continue; // 今回検出/再発ぶんはそのまま
      if (pulled.receivedTermIds.has(conflict.termId)) {
        // 語単位の判定(peer単位ではない): その語の新鮮なデータが届いたのに競合が
        // 再発しなかった=決着済みとみなす。3台以上で別peerのデータが届いた場合も
        // LWW連鎖で内容は収束しているため、この単純化を許容する
        await deps.noteConflictsRepo.closeAuto(conflict.id, 'superseded', now);
      } else {
        await deps.noteConflictsRepo.carryOver(conflict.id, syncEventId);
      }
    }

    const linked = await deps.noteConflictsRepo.getBySyncEventId(syncEventId);
    await deps.syncEventsRepo.updateOutcome(syncEventId, {
      receivedBlobs: pulled.receivedBlobs,
      skippedBlobs: pulled.skippedBlobs,
      conflictCount: linked.length,
      peerDeviceIds: [...pulled.peerDeviceIds],
      completed: true,
    });
  });

  const linkedCount = (await deps.noteConflictsRepo.getBySyncEventId(syncEventId)).length;
  return {
    syncEventId,
    receivedBlobs: pulled.receivedBlobs,
    skippedBlobs: pulled.skippedBlobs,
    conflictCount: linkedCount,
    adoptedDecisions: pulled.adoptedDecisions,
  };
}
