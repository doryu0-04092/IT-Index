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
  getById(id: string): Promise<TermRecord | undefined>;
  bulkPutFromSeed(terms: TermRecord[]): Promise<void>;
  upsertFromAi(term: TermRecord): Promise<void>;
  upsertFromSync(term: TermRecord): Promise<void>;
}

export function createTermsRepository(db: ItIndexDB): TermsRepository {
  return {
    async getAll() {
      return db.terms.filter((t) => t.deletedAt === null).toArray();
    },

    async getById(id) {
      return db.terms.get(id);
    },

    async bulkPutFromSeed(terms) {
      await db.transaction('rw', db.terms, async () => {
        await db.terms.bulkPut(terms);
      });
    },

    async upsertFromAi(term) {
      await db.terms.put(term);
    },

    async upsertFromSync(term) {
      await db.terms.put(term);
    },
  };
}
