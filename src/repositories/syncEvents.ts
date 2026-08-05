import type { ItIndexDB } from '../db';
import type { SyncEventRecord } from '../types';

export interface SyncEventsRepository {
  /** 連携1回ぶんを記録する。単語の増減が無い（term/noteどちらも空の）exchangeは呼び出し側で記録しない */
  add(peerDeviceId: string, receivedTermIds: string[], sentTermIds: string[], at: number): Promise<void>;
  /** 新しい順 */
  getAllOrdered(): Promise<SyncEventRecord[]>;
}

export function createSyncEventsRepository(db: ItIndexDB): SyncEventsRepository {
  return {
    async add(peerDeviceId, receivedTermIds, sentTermIds, at) {
      const record: SyncEventRecord = { id: crypto.randomUUID(), at, peerDeviceId, receivedTermIds, sentTermIds };
      await db.syncEvents.add(record);
    },

    async getAllOrdered() {
      const all = await db.syncEvents.orderBy('at').toArray();
      return all.reverse();
    },
  };
}
