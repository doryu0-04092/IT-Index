import type { NoteConflict } from '../core/mergeSnapshot';
import type { ItIndexDB } from '../db';
import type { NoteConflictRecord } from '../types';

export interface NoteConflictsRepository {
  /** 競合検出時（importSyncFiles）に1件保存する。保存済みレコードを返す */
  add(conflict: NoteConflict, peerDeviceId: string, detectedAt: number): Promise<NoteConflictRecord>;
  /** 新しい順（取り込み履歴タブでの表示用）。未解決・解決済み両方を含む */
  getAllOrdered(): Promise<NoteConflictRecord[]>;
  getById(id: string): Promise<NoteConflictRecord | undefined>;
  /** 選択・選び直し。merged は 'merged' を選ぶ時だけ渡す（AI統合結果をキャッシュする） */
  setResolution(
    id: string,
    resolution: 'local' | 'remote' | 'merged',
    merged: { body: string; diagrams: string[] } | null,
    at: number,
  ): Promise<void>;
}

export function createNoteConflictsRepository(db: ItIndexDB): NoteConflictsRepository {
  return {
    async add(conflict, peerDeviceId, detectedAt) {
      const record: NoteConflictRecord = {
        id: crypto.randomUUID(),
        termId: conflict.termId,
        detectedAt,
        peerDeviceId,
        local: conflict.local,
        remote: conflict.remote,
        resolution: null,
        merged: null,
        resolvedAt: null,
      };
      await db.noteConflicts.add(record);
      return record;
    },

    async getAllOrdered() {
      const all = await db.noteConflicts.orderBy('detectedAt').toArray();
      return all.reverse();
    },

    async getById(id) {
      return db.noteConflicts.get(id);
    },

    async setResolution(id, resolution, merged, at) {
      await db.noteConflicts.update(id, {
        resolution,
        // 既にキャッシュ済みのmergedを、local/remote選択時に消さない
        // （後で「統合済みを採用」を選ぶ時に再度AIを呼ばずに再利用できるようにするため）
        ...(merged ? { merged } : {}),
        resolvedAt: at,
      });
    },
  };
}
