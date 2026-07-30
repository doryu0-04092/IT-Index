import type { SeedFile, SeedTermInput } from '../core/validateSeed';
import { FIELDS, type TermRecord } from '../types';

/**
 * docs/local-data.md の変更データ層（`data/terms.json`）。
 * origin:'ai' の語のみを対象にする。形式はシード（docs/seed-format.md）と完全に同一
 * （term/readings/summary/field/tags）——Claude Code が既に把握している形式を
 * そのまま使い回せるようにするための意図的な選択。
 */
export const LOCAL_TERMS_SCHEMA_VERSION = 1;

/** `TermRecord[]`（origin:'ai'）から `data/terms.json` の内容を組み立てる */
export function buildLocalTermsFile(aiTerms: TermRecord[], version: string): SeedFile {
  return {
    schemaVersion: LOCAL_TERMS_SCHEMA_VERSION,
    version,
    terms: aiTerms
      .filter((t) => t.deletedAt === null)
      .map(
        (t): SeedTermInput => ({
          term: t.term,
          readings: t.readings,
          // summary が null なのは 2026-07-29 以前に登録された origin:'ai' 語の後方互換
          // （types.ts の TermRecord.summary コメント参照）。空文字で書き出し、取り込み時に
          // null へ戻す（validateLocalTermsFile 参照）。
          summary: t.summary ?? '',
          field: t.field,
          tags: t.tags.length > 0 ? t.tags : undefined,
        }),
      ),
  };
}

export type LocalTermsValidationResult = { ok: true; file: SeedFile } | { ok: false; reason: string };

const KNOWN_SCHEMA_VERSIONS = [LOCAL_TERMS_SCHEMA_VERSION];

/**
 * `data/terms.json` の検証。`src/core/validateSeed.ts` の `validateSeedFile()` とほぼ同じだが、
 * 1点だけ意図的に緩めてある: `summary` の空文字を許し、null として扱う。
 *
 * 理由: シードの `validateSeedFile()` は summary 必須（空文字は違反）。しかし変更データ層には
 * 2026-07-29 以前に登録された summary:null の origin:'ai' 語が残っている場合があり、
 * これを厳密な `validateSeedFile()` にそのまま通すと、その1語のために**ファイル全体の取り込みが
 * 恒久的に失敗し続ける**（検証失敗時は全件中止するため）。`validateSeedFile()` を流用せず
 * 専用の検証を用意することで、この一語のために取り込み全体が壊れる事態を避ける。
 */
export function validateLocalTermsFile(raw: unknown): LocalTermsValidationResult {
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
    // シードと違い、空文字を許す（summary:null の後方互換語のため）
    if (typeof t.summary !== 'string') {
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
