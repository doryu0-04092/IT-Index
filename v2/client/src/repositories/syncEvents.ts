import type { ItIndexDB } from '../db';
import type { SyncEventRecord } from '../types';

/**
 * 同期実行の記録(#157)。競合(noteConflicts.syncEventId)がここへリンクし、
 * 「どの同期でこの競合が発生・持ち越されたか」を辿れる。端末ローカルで同期対象外。
 */
export interface SyncEventsRepository {
  put(event: SyncEventRecord): Promise<void>;
  getLatest(): Promise<SyncEventRecord | undefined>;
  /** 新しい順にn件(履歴画面の「連携履歴」タブ用) */
  getRecent(limit: number): Promise<SyncEventRecord[]>;
  /** pull完走時に結果を確定する(照合フェーズと同じトランザクション内で呼ぶ) */
  updateOutcome(
    id: string,
    outcome: {
      receivedBlobs: number;
      skippedBlobs: number;
      conflictCount: number;
      peerDeviceIds: string[];
      completed: boolean;
    },
  ): Promise<void>;
}

export function createSyncEventsRepository(db: ItIndexDB): SyncEventsRepository {
  return {
    async put(event) {
      await db.syncEvents.put(event);
    },

    async getLatest() {
      const latest = await db.syncEvents.orderBy('at').last();
      return latest ?? undefined;
    },

    async getRecent(limit) {
      return db.syncEvents.orderBy('at').reverse().limit(limit).toArray();
    },

    async updateOutcome(id, outcome) {
      await db.syncEvents.update(id, outcome);
    },
  };
}
