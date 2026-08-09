import type { AskRecord } from '@it-index/shared';
import type { ItIndexDB } from '../db';

export interface AsksRepository {
  /**
   * ローカル検索の結果から用語詳細を開いた「確定」1件を追加する(source:'search'。
   * v1 ../../src/repositories/asks.ts参照。要件定義書§4.1で引き継ぐ機能)。
   */
  addSearchConfirm(termId: string, deviceId: string, at: number): Promise<void>;
  /**
   * (at, id)の通し番号順に全件取得。computeWeights()の入力。
   * v2のasksテーブルは`[at+id]`複合インデックスを持たない(db.ts参照)ため、
   * ここでJS側で同じ順序(at昇順、同じatはid昇順でタイブレーク)にソートする。
   */
  getAllOrdered(): Promise<AskRecord[]>;
  getByTermId(termId: string): Promise<AskRecord[]>;
}

function compareAsks(a: AskRecord, b: AskRecord): number {
  if (a.at !== b.at) return a.at - b.at;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function createAsksRepository(db: ItIndexDB): AsksRepository {
  return {
    async addSearchConfirm(termId, deviceId, at) {
      const record: AskRecord = { id: crypto.randomUUID(), termId, sessionId: null, at, deviceId, source: 'search' };
      await db.asks.add(record);
    },

    async getAllOrdered() {
      const all = await db.asks.toArray();
      return all.sort(compareAsks);
    },

    async getByTermId(termId) {
      return db.asks.where('termId').equals(termId).toArray();
    },
  };
}
