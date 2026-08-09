import type { ItIndexDB } from '../db';
import type { SyncStateRecord } from '../types';

export interface SyncStateRepository {
  /** 未取り込みなら0(全件pull)を返す */
  getCursor(): Promise<number>;
  setCursor(cursor: number): Promise<void>;
}

export function createSyncStateRepository(db: ItIndexDB): SyncStateRepository {
  return {
    async getCursor() {
      const existing = await db.syncState.get('singleton');
      return existing?.cursor ?? 0;
    },

    async setCursor(cursor) {
      const record: SyncStateRecord = { key: 'singleton', cursor };
      await db.syncState.put(record);
    },
  };
}
