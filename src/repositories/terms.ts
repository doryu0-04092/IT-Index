import type { ItIndexDB } from '../db';
import { normalize } from '../core/normalize';
import type { Field, TermRecord } from '../types';

export function makeTermId(term: string): string {
  return normalize(term);
}

/**
 * シード取り込み・AI新規登録の両方で使う共通の組み立て。
 * summary は origin:'ai' の場合 null を渡す（初期説明という概念自体が無いため。§types.ts参照）。
 */
export function buildTermRecord(input: {
  term: string;
  readings: string[];
  summary: string | null;
  field: Field;
  tags?: string[];
  origin: 'seed' | 'ai';
  now: number;
}): TermRecord {
  return {
    id: makeTermId(input.term),
    term: input.term,
    readings: input.readings,
    summary: input.summary,
    field: input.field,
    tags: input.tags ?? [],
    searchKey: normalize(input.term),
    readingKeys: input.readings.map(normalize),
    origin: input.origin,
    createdAt: input.now,
    updatedAt: input.now,
    deletedAt: null,
  };
}

export interface TermsRepository {
  getAll(): Promise<TermRecord[]>;
  /**
   * tombstone（削除済み）も含めた全件。**同期でだけ使う。**
   * `getAll()` は表示用に削除済みを除くが、それを同期の送信データに使うと「削除した」という
   * 事実が相手に伝わらず、相手が持っている削除前のレコードがマージで戻ってきてしまう
   * （実際に起きていた不具合）。tombstone を送れば `mergeSnapshot` の updatedAt 比較で
   * 削除が正しく勝つ。
   */
  getAllForSync(): Promise<TermRecord[]>;
  getById(id: string): Promise<TermRecord | undefined>;
  bulkPutFromSeed(terms: TermRecord[]): Promise<void>;
  upsertFromAi(term: TermRecord): Promise<void>;
  upsertFromSync(term: TermRecord): Promise<void>;
  /** 利用者による明示的な削除（単語詳細画面）。tombstoneするだけで物理削除はしない */
  softDelete(id: string, now: number): Promise<void>;
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
        // 利用者が明示的に削除した語を、シード更新で勝手に復活させない。
        // シード側のレコードは常に deletedAt:null で組み立てられるため、ここで
        // 既存の tombstone を引き継がないと「削除したはずの内蔵語が次のシード更新で全部戻る」
        // ことになる（実際に起きていた不具合）。
        const existing = await db.terms.bulkGet(terms.map((t) => t.id));
        const merged = terms.map((term, i) => {
          const prev = existing[i];
          return prev && prev.deletedAt !== null ? { ...term, deletedAt: prev.deletedAt } : term;
        });
        await db.terms.bulkPut(merged);
      });
    },

    async upsertFromAi(term) {
      await db.terms.put(term);
    },

    async upsertFromSync(term) {
      await db.terms.put(term);
    },

    async softDelete(id, now) {
      const term = await db.terms.get(id);
      if (!term) return;
      await db.terms.put({ ...term, deletedAt: now, updatedAt: now });
    },
  };
}
