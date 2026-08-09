import type { NoteRecord } from '@it-index/shared';
import type { ItIndexDB } from '../db';

export interface NotesRepository {
  getByTermId(termId: string): Promise<NoteRecord | undefined>;
  /** 全件取得。将来の同期用マージ入力の組み立てに使う想定(v1 ../../src/repositories/notes.ts参照) */
  getAll(): Promise<NoteRecord[]>;
  /**
   * ノート本文の編集保存。呼ぶたびに旧内容をnoteHistoryへ退避してから上書きする
   * (v1のapplyCommitと同じ考え方。ロールバック用の記録で、同期対象外)。
   */
  saveBody(termId: string, body: string, deviceId: string, at: number): Promise<void>;
}

export function createNotesRepository(db: ItIndexDB): NotesRepository {
  return {
    async getByTermId(termId) {
      return db.notes.get(termId);
    },

    async getAll() {
      return db.notes.toArray();
    },

    async saveBody(termId, body, deviceId, at) {
      await db.transaction('rw', db.notes, async () => {
        const existing = await db.notes.get(termId);
        const noteHistory = existing
          ? [...existing.noteHistory, { body: existing.body, diagrams: existing.diagrams, updatedAt: existing.updatedAt }]
          : [];

        const next: NoteRecord = {
          termId,
          body,
          diagrams: existing?.diagrams ?? [],
          updatedAt: at,
          lastEditedBy: deviceId,
          noteHistory,
        };
        await db.notes.put(next);
      });
    },
  };
}
