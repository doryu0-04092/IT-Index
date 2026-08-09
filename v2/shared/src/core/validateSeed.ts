import { FIELDS, type Field } from '../types';

export interface SeedTermInput {
  term: string;
  readings: string[];
  summary: string;
  field: Field;
  tags?: string[];
}

export interface SeedFile {
  schemaVersion: number;
  version: string;
  terms: SeedTermInput[];
}

export type SeedValidationResult = { ok: true; file: SeedFile } | { ok: false; reason: string };

/** アプリが知っている seed-format.md の schemaVersion 一覧 */
const KNOWN_SCHEMA_VERSIONS = [1];

/**
 * docs/seed-format.md §8「取り込み時にアプリが行う検証」をそのまま実装する。
 * 1つでも違反があれば取り込みを中止する（＝既存データを保持する）ため、
 * このモジュールは fetch も IndexedDB も持たない純関数として切り出す。
 */
export function validateSeedFile(raw: unknown): SeedValidationResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'ルート要素がオブジェクトではありません' };
  }
  const data = raw as Record<string, unknown>;

  if (typeof data.schemaVersion !== 'number' || !KNOWN_SCHEMA_VERSIONS.includes(data.schemaVersion)) {
    return { ok: false, reason: `未知の schemaVersion です: ${String(data.schemaVersion)}` };
  }
  if (typeof data.version !== 'string' || data.version === '') {
    return { ok: false, reason: 'version がありません' };
  }
  if (!Array.isArray(data.terms)) {
    return { ok: false, reason: 'terms が配列ではありません' };
  }

  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (let index = 0; index < data.terms.length; index++) {
    const entry = data.terms[index];
    if (typeof entry !== 'object' || entry === null) {
      return { ok: false, reason: `terms[${index}] がオブジェクトではありません` };
    }
    const t = entry as Record<string, unknown>;

    if (typeof t.term !== 'string' || t.term === '') {
      return { ok: false, reason: `terms[${index}].term がありません` };
    }
    if (!Array.isArray(t.readings) || t.readings.length === 0 || !t.readings.every((r) => typeof r === 'string')) {
      return { ok: false, reason: `${t.term}: readings は1要素以上の文字列配列である必要があります` };
    }
    if (typeof t.summary !== 'string' || t.summary === '') {
      return { ok: false, reason: `${t.term}: summary がありません` };
    }
    if (typeof t.field !== 'string' || !(FIELDS as readonly string[]).includes(t.field)) {
      return { ok: false, reason: `${t.term}: field が一覧にありません: ${String(t.field)}` };
    }
    if (t.tags !== undefined && (!Array.isArray(t.tags) || !t.tags.every((tag) => typeof tag === 'string'))) {
      return { ok: false, reason: `${t.term}: tags が不正です` };
    }

    if (seen.has(t.term)) duplicates.add(t.term);
    seen.add(t.term);
  }

  if (duplicates.size > 0) {
    return { ok: false, reason: `term が重複しています: ${[...duplicates].join(', ')}` };
  }

  return {
    ok: true,
    file: {
      schemaVersion: data.schemaVersion,
      version: data.version,
      terms: data.terms as SeedTermInput[],
    },
  };
}
