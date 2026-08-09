import { normalize } from './normalize';
import type { Field, TermRecord } from '../types';

/**
 * TermRecordの組み立て。v1の src/repositories/terms.ts から純関数部分のみ移植
 * (リポジトリ本体はDexie依存のためclient側で実装する)。
 */
export function makeTermId(term: string): string {
  return normalize(term);
}

/**
 * シード取り込み・AI新規登録の両方で使う共通の組み立て。
 * summary は origin:'ai' の場合 null を渡す(初期説明という概念自体が無いため。§types.ts参照)。
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
