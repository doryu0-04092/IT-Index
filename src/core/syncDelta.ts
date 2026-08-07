import type { NoteRecord, TermRecord } from '../types';
import { isSameContent } from './mergeSnapshot';

/** ある同期のやり取りで「新しく増えた/変わった」内容。単語一覧（termIds）とノート（noteTermIds） */
export interface SyncDelta {
  termIds: string[];
  noteTermIds: string[];
}

interface DeltaSource {
  notes: NoteRecord[];
  aiTerms: TermRecord[];
}

/**
 * before から after への差分を「相手に新しく渡った/相手から新しく受け取った」の判定に使う。
 * before/after は SyncFile・LocalSnapshot どちらの形でも渡せる（notes/aiTerms の形が同じため）。
 *
 * 用語(aiTerms)は id が同じでも updatedAt が違えば変化ありとみなす。
 * ノート(notes)は id を持たないため termId + 内容一致（isSameContent）で判定する。
 */
export function computeSyncDelta(before: DeltaSource, after: DeltaSource): SyncDelta {
  const beforeTerms = new Map(before.aiTerms.map((t) => [t.id, t]));
  const termIds = after.aiTerms
    .filter((t) => {
      const prev = beforeTerms.get(t.id);
      return !prev || prev.updatedAt !== t.updatedAt;
    })
    .map((t) => t.id);

  const beforeNotes = new Map(before.notes.map((n) => [n.termId, n]));
  const noteTermIds = after.notes
    .filter((n) => {
      const prev = beforeNotes.get(n.termId);
      return !prev || !isSameContent(prev, n);
    })
    .map((n) => n.termId);

  return { termIds, noteTermIds };
}
