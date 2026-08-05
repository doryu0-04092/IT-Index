import type { AskRecord, NoteRecord, TermRecord } from '../types';

/** device-*.json の中身。docs/architecture.md §4.2「同期ファイルの構造」 */
export interface SyncFile {
  syncSchemaVersion: 1;
  deviceId: string;
  writtenAt: number;
  notes: NoteRecord[];
  asks: AskRecord[];
  aiTerms: TermRecord[];
}

/** 現端末のローカルデータのうち、同期対象部分だけを渡す */
export interface LocalSnapshot {
  notes: NoteRecord[];
  asks: AskRecord[];
  aiTerms: TermRecord[];
}

/** 両端末で更新され、決定的コードでは判断できない箇所（要件定義書 §5.5） */
export interface NoteConflict {
  termId: string;
  local: NoteRecord;
  remote: NoteRecord;
}

export interface MergeResult {
  notes: NoteRecord[];
  conflicts: NoteConflict[];
  asks: AskRecord[];
  terms: TermRecord[];
}

/**
 * 決定的マージ。AIを使わず規則だけで行う（docs/requirements.md §5.5）。
 * - notes: updatedAt が新しい方を採用。ただし local と remote の内容が食い違う場合は
 *   conflicts にも積む（AIによる統合は任意の追加提案であり、ここでの newest-wins が
 *   鍵の無い状態でも単独で完結するフォールバックになる）
 * - asks: id で和集合
 * - terms（origin:'ai' の語）: id で和集合。同一 id は updatedAt が新しい方
 *
 * 同じスナップショットを2回マージしても結果が変わらない（冪等）ことをテストで固める対象。
 */
export function mergeSnapshot(local: LocalSnapshot, remoteFiles: SyncFile[]): MergeResult {
  const notes: NoteRecord[] = [];
  const conflicts: NoteConflict[] = [];

  const termIds = new Set<string>();
  local.notes.forEach((n) => termIds.add(n.termId));
  remoteFiles.forEach((f) => f.notes.forEach((n) => termIds.add(n.termId)));

  for (const termId of termIds) {
    const localNote = local.notes.find((n) => n.termId === termId);
    const remoteNotes = remoteFiles.flatMap((f) => f.notes).filter((n) => n.termId === termId);
    const candidates = [...(localNote ? [localNote] : []), ...remoteNotes];

    const newest = [...candidates].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    notes.push(newest);

    if (localNote) {
      const conflictingRemote = remoteNotes.find((r) => isRealConflict(localNote, r));
      if (conflictingRemote) {
        conflicts.push({ termId, local: localNote, remote: conflictingRemote });
      }
    }
  }

  const askMap = new Map<string, AskRecord>();
  local.asks.forEach((a) => askMap.set(a.id, a));
  remoteFiles.forEach((f) => f.asks.forEach((a) => askMap.set(a.id, a)));

  const termMap = new Map<string, TermRecord>();
  local.aiTerms.forEach((t) => termMap.set(t.id, t));
  remoteFiles.forEach((f) =>
    f.aiTerms.forEach((t) => {
      const existing = termMap.get(t.id);
      if (!existing || t.updatedAt > existing.updatedAt) termMap.set(t.id, t);
    }),
  );

  return {
    notes,
    conflicts,
    asks: [...askMap.values()],
    terms: [...termMap.values()],
  };
}

/** src/core/syncDelta.ts でも使う（内容比較。updatedAt/lastEditedByは見ない） */
export function isSameContent(a: NoteRecord, b: NoteRecord): boolean {
  return a.body === b.body && JSON.stringify(a.diagrams) === JSON.stringify(b.diagrams);
}

/**
 * 「両方の端末が**それぞれ独自に**編集した」と言えるものだけを競合として扱う（2026-08-05）。
 *
 * 以前は「内容が違えば競合」としていたが、それでは**片方でしか編集していない場合も競合になる**。
 * 例: PCで語Aを育てる → 連携でAndroidへコピー → その後PCだけでさらに育てる → もう一度連携。
 * このときAndroidは何もしていないのに、持っている内容はPCの古い版なので「内容が違う」に該当し、
 * 競合として数え上げられていた。連携のたびに本物でない競合が並ぶと、確認画面が見られなくなる。
 *
 * この実装は共通の祖先を記録していない（3-wayマージではない）ため、次の2つの手掛かりで
 * 「相手は独自に編集していない」と言い切れる場合を競合から外す:
 *
 * 1. **`lastEditedBy` が同じ** — 相手が持っているのは同じ端末が書いた版。相手はそれを
 *    受け取っただけで、自分では書いていない
 * 2. **相手の内容がこちらの過去版そのもの** — `noteHistory` は上書き前の版の積み重ね
 *    （`NotesRepository.applyCommit`）。ここに一致があれば、相手はこちらの古い版を
 *    持っているだけで、単に遅れている
 *
 * どちらにも当てはまらない場合だけを競合として残す。なお相手の `noteHistory` は同期で
 * 送られてこない（端末ローカルな記録のため `stripNoteHistory` で落としている）ので、
 * 2の判定は「こちらが進んでいる」向きにしか効かない。逆向き（こちらが遅れている）は
 * 1の `lastEditedBy` 判定で拾う。
 */
function isRealConflict(localNote: NoteRecord, remoteNote: NoteRecord): boolean {
  if (isSameContent(remoteNote, localNote)) return false;
  if (remoteNote.lastEditedBy === localNote.lastEditedBy) return false;

  const remoteIsOurPastVersion = localNote.noteHistory.some(
    (h) => h.body === remoteNote.body && JSON.stringify(h.diagrams) === JSON.stringify(remoteNote.diagrams),
  );
  return !remoteIsOurPastVersion;
}
