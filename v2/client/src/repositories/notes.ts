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
  /**
   * 同期の取り込み専用(v1 ../../src/repositories/notes.ts参照)。updatedAt比較は行わない
   * ——mergeSnapshot()が既に決定的マージ済みの結果をそのまま書く。noteHistoryは
   * 同期対象外のためレコードごと置き換えず、既存の履歴を保つ。
   */
  upsertFromSync(note: NoteRecord): Promise<void>;
  /**
   * 競合解消(SyncScreen)専用。採用しなかった側(rejected)の内容もnoteHistoryへ積むことで、
   * 次回同じ相手と同期しても同じ2版が再び競合として検出されないようにする
   * (2026-08-07のv1修正と同じ理由。core/mergeSnapshot.ts の isRealConflict 参照)。
   */
  applyConflictResolution(
    termId: string,
    body: string,
    diagrams: string[],
    deviceId: string,
    at: number,
    rejected: { body: string; diagrams: string[] },
  ): Promise<void>;
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

    async upsertFromSync(note) {
      // noteHistoryは「この端末で上書きする前の版」の積み重ねで、ロールバック用の
      // 端末ローカルな記録(types.tsに「同期対象外」と明記)。レコードごとputすると
      // 相手のnoteHistory(送信時に空配列。core/syncTarget.ts参照)で置き換わってしまうため、
      // 本文(body/diagrams)は同期するが履歴はこちらのものを保つ。
      await db.transaction('rw', db.notes, async () => {
        const existing = await db.notes.get(note.termId);
        await db.notes.put({ ...note, noteHistory: existing?.noteHistory ?? [] });
      });
    },

    async applyConflictResolution(termId, body, diagrams, deviceId, at, rejected) {
      await db.transaction('rw', db.notes, async () => {
        const existing = await db.notes.get(termId);
        const noteHistory = existing ? [...existing.noteHistory] : [];

        // 同じ内容は積み直さない。選び直しのたびに無条件で積み増すと、実際には2種類しかない
        // 本文でnoteHistoryが際限なく伸びる(v1 2026-08-07の修正と同じ理由)。
        const remember = (entry: { body: string; diagrams: string[]; updatedAt: number }) => {
          const seen = noteHistory.some(
            (h) => h.body === entry.body && JSON.stringify(h.diagrams) === JSON.stringify(entry.diagrams),
          );
          if (!seen) noteHistory.push(entry);
        };

        if (existing) {
          remember({ body: existing.body, diagrams: existing.diagrams, updatedAt: existing.updatedAt });
        }
        remember({ body: rejected.body, diagrams: rejected.diagrams, updatedAt: at });

        const next: NoteRecord = { termId, body, diagrams, updatedAt: at, lastEditedBy: deviceId, noteHistory };
        await db.notes.put(next);
      });
    },
  };
}
