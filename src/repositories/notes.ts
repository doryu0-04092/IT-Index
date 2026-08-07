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
  /**
   * 競合解消（`ConflictResolver`・履歴タブ）専用。`applyCommit`と同様に上書き前の内容を
   * noteHistoryへ積むのに加えて、**採用しなかった側**（`rejected`）の内容も積む。
   *
   * これが無いと、次回また同じ相手と連携した時に isRealConflict()（mergeSnapshot.ts）が
   * 「相手の内容が自分の履歴に無い」と判定し、同じ2版が再び競合として検出されてしまう
   * （2026-08-07修正）。`rejected`は「相手を採用」を選んだ場合は自分の元の内容、
   * それ以外（この端末を採用／AIで統合）を選んだ場合は相手の内容を渡す。
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

    async applyConflictResolution(termId, body, diagrams, deviceId, at, rejected) {
      await db.transaction('rw', db.notes, async () => {
        const existing = await db.notes.get(termId);
        const noteHistory = existing ? [...existing.noteHistory] : [];

        // 同じ内容は積み直さない。この操作は「いつでも選び直せる」ものなので、利用者が2案を
        // 往復するたびに applyCommit と同じ無条件の積み増しをすると、実際には2種類しかない
        // 本文で noteHistory が際限なく伸びる（往復3回で3件になるのを実測。2026-08-07）。
        // ここで必要なのは時系列の記録ではなく「この版は見たことがある」という集合
        // ——競合の再検出を防ぐ isRealConflict() がその用途で参照するため（mergeSnapshot.ts）。
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
