import type { ItIndexDB } from '../db';
import type { AskRecord } from '../types';

export interface AsksRepository {
  /** 分配先の全語に1件ずつ、1トランザクションで追加する（AIチャット確定時。source:'ai'） */
  addMany(asks: Omit<AskRecord, 'id'>[]): Promise<void>;
  /**
   * ローカル検索の結果から用語詳細を開いた「確定」1件を追加する（source:'search'。
   * 要件定義書§5.4、2026-07-29追加）。検索欄への入力や一覧の閲覧だけでは呼ばない
   * ——実際に1つの語を選んで詳細を開いた操作だけを「確定」とみなす。
   */
  addSearchConfirm(termId: string, deviceId: string, at: number): Promise<void>;
  /** [at+id] インデックスで全件取得。computeWeights() の入力 */
  getAllOrdered(): Promise<AskRecord[]>;
  getByTermId(termId: string): Promise<AskRecord[]>;
  /** id の和集合。既存 id はスキップ */
  upsertFromSync(asks: AskRecord[]): Promise<void>;
  /** 全件削除。ローカルデータの初期化（検索履歴のリセット）で使う */
  clearAll(): Promise<void>;
}

export function createAsksRepository(db: ItIndexDB): AsksRepository {
  return {
    async addMany(asks) {
      const records: AskRecord[] = asks.map((a) => ({ ...a, id: crypto.randomUUID() }));
      await db.transaction('rw', db.asks, async () => {
        await db.asks.bulkAdd(records);
      });
    },

    async addSearchConfirm(termId, deviceId, at) {
      const record: AskRecord = { id: crypto.randomUUID(), termId, sessionId: null, at, deviceId, source: 'search' };
      await db.asks.add(record);
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

    async clearAll() {
      await db.asks.clear();
    },
  };
}
