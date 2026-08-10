import type { TermRecord } from '@it-index/shared';
import type { ItIndexDB } from '../db';

export interface TermsRepository {
  getAll(): Promise<TermRecord[]>;
  /**
   * tombstone(削除済み)も含めた全件。同期用(v1 ../../src/repositories/terms.ts参照。
   * 現時点のv2にはまだ同期機能自体が無いが、送信データの組み立てで「削除した」事実を
   * 相手に伝える必要があるという不具合対策自体は落とさずここに残す)。
   */
  getAllForSync(): Promise<TermRecord[]>;
  getById(id: string): Promise<TermRecord | undefined>;
  bulkPutFromSeed(terms: TermRecord[]): Promise<void>;
  /** 利用者による明示的な削除(単語詳細画面)。tombstoneするだけで物理削除はしない */
  softDelete(id: string, now: number): Promise<void>;
  /**
   * 同期の取り込み専用(v1 ../../src/repositories/terms.ts参照)。updatedAt比較は行わない
   * ——mergeSnapshot()が既に決定的マージ済みの結果をそのまま書く。
   */
  upsertFromSync(term: TermRecord): Promise<void>;
  /** AIチャットの確定(分配統合)による新規登録専用(v1 ../../src/repositories/terms.ts参照) */
  upsertFromAi(term: TermRecord): Promise<void>;
}

export function createTermsRepository(db: ItIndexDB): TermsRepository {
  return {
    async getAll() {
      return db.terms.filter((t) => t.deletedAt === null).toArray();
    },

    async getAllForSync() {
      return db.terms.toArray();
    },

    async getById(id) {
      const term = await db.terms.get(id);
      return term && term.deletedAt === null ? term : undefined;
    },

    async bulkPutFromSeed(terms) {
      await db.transaction('rw', db.terms, async () => {
        // 利用者が明示的に削除した語を、シード更新で勝手に復活させない(v1で実際に起きていた
        // 不具合。../../src/repositories/terms.ts参照)。シード側のレコードは常にdeletedAt:null
        // で組み立てられるため、既存のtombstoneをここで引き継ぐ。
        const existing = await db.terms.bulkGet(terms.map((t) => t.id));
        const merged = terms.map((term, i) => {
          const prev = existing[i];
          return prev && prev.deletedAt !== null ? { ...term, deletedAt: prev.deletedAt } : term;
        });
        await db.terms.bulkPut(merged);
      });
    },

    async softDelete(id, now) {
      const term = await db.terms.get(id);
      if (!term) return;
      await db.terms.put({ ...term, deletedAt: now, updatedAt: now });
    },

    async upsertFromSync(term) {
      await db.terms.put(term);
    },

    async upsertFromAi(term) {
      await db.terms.put(term);
    },
  };
}
