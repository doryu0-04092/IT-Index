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
      const conflictingRemote = remoteNotes.find((r) => !isSameContent(r, localNote));
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

function isSameContent(a: NoteRecord, b: NoteRecord): boolean {
  return a.body === b.body && JSON.stringify(a.diagrams) === JSON.stringify(b.diagrams);
}
