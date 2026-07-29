import type { ItIndexDB } from '../db';
import type { AskRecord } from '../types';

export interface AsksRepository {
  /** 分配先の全語に1件ずつ、1トランザクションで追加する */
  addMany(asks: Omit<AskRecord, 'id'>[]): Promise<void>;
  /** [at+id] インデックスで全件取得。computeWeights() の入力 */
  getAllOrdered(): Promise<AskRecord[]>;
  getByTermId(termId: string): Promise<AskRecord[]>;
  /** id の和集合。既存 id はスキップ */
  upsertFromSync(asks: AskRecord[]): Promise<void>;
}

export function createAsksRepository(db: ItIndexDB): AsksRepository {
  return {
    async addMany(asks) {
      const records: AskRecord[] = asks.map((a) => ({ ...a, id: crypto.randomUUID() }));
      await db.transaction('rw', db.asks, async () => {
        await db.asks.bulkAdd(records);
      });
    },

    async getAllOrdered() {
      return db.asks.orderBy('[at+id]').toArray();
    },

    async getByTermId(termId) {
      return db.asks.where('termId').equals(termId).toArray();
    },

    async upsertFromSync(asks) {
      await db.transaction('rw', db.asks, async () => {
        for (const ask of asks) {
          const existing = await db.asks.get(ask.id);
          if (!existing) await db.asks.add(ask);
        }
      });
    },
  };
}
