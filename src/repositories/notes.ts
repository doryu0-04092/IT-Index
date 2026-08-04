import type { ItIndexDB } from '../db';
import type { NoteRecord } from '../types';

export interface NotesRepository {
  getByTermId(termId: string): Promise<NoteRecord | undefined>;
  /** Drive同期用の全件取得。マージ入力（ローカルスナップショット）を組み立てるのに使う */
  getAll(): Promise<NoteRecord[]>;
  /** 確定時のみ呼ばれる。呼ぶたびに noteHistory へ旧内容を退避してから上書きする */
  applyCommit(termId: string, body: string, diagrams: string[], deviceId: string, at: number): Promise<void>;
  /** updatedAt 比較は行わない。mergeSnapshot() が決定した結果をそのまま書く */
  upsertFromSync(note: NoteRecord): Promise<void>;
}

export function createNotesRepository(db: ItIndexDB): NotesRepository {
  return {
    async getByTermId(termId) {
      return db.notes.get(termId);
    },

    async getAll() {
      return db.notes.toArray();
    },

    async applyCommit(termId, body, diagrams, deviceId, at) {
      await db.transaction('rw', db.notes, async () => {
        const existing = await db.notes.get(termId);
        const noteHistory = existing
          ? [...existing.noteHistory, { body: existing.body, diagrams: existing.diagrams, updatedAt: existing.updatedAt }]
          : [];

        const next: NoteRecord = {
          termId,
          body,
          diagrams,
          updatedAt: at,
          lastEditedBy: deviceId,
          noteHistory,
        };
        await db.notes.put(next);
      });
    },

    async upsertFromSync(note) {
      // noteHistory は「この端末で上書きする前の版」の積み重ねで、ロールバック用の
      // **端末ローカルな記録**（types.ts に「同期対象外」と明記）。レコードごと put すると
      // 相手の noteHistory で置き換わり、この端末で積んだ版が消えてロールバックできなくなる。
      // 本文（body/diagrams）は同期するが、履歴はこちらのものを保つ。
      await db.transaction('rw', db.notes, async () => {
        const existing = await db.notes.get(note.termId);
        await db.notes.put({ ...note, noteHistory: existing?.noteHistory ?? [] });
      });
    },
  };
}
