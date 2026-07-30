import { describe, expect, it } from 'vitest';
import { buildTermRecord } from '../repositories/terms';
import { buildLocalTermsFile, validateLocalTermsFile } from './termsFile';

describe('buildLocalTermsFile', () => {
  it('includes only non-deleted origin:ai terms', () => {
    const aiTerm = buildTermRecord({
      term: 'CORS',
      readings: ['シーオーアールエス'],
      summary: '仕組み。',
      field: 'セキュリティ',
      origin: 'ai',
      now: 1,
    });
    const deleted = { ...buildTermRecord({ term: '廃止語', readings: ['はいしご'], summary: null, field: 'AI', origin: 'ai', now: 1 }), deletedAt: 2 };

    const file = buildLocalTermsFile([aiTerm, deleted], '2026-07-30');

    expect(file.terms.map((t) => t.term)).toEqual(['CORS']);
    expect(file.terms[0].summary).toBe('仕組み。');
  });

  it('writes summary:null as an empty string', () => {
    const term = buildTermRecord({ term: 'MTU', readings: ['えむてぃーゆー'], summary: null, field: 'ネットワーク', origin: 'ai', now: 1 });

    const file = buildLocalTermsFile([term], '2026-07-30');

    expect(file.terms[0].summary).toBe('');
  });

  it('omits tags when empty', () => {
    const term = buildTermRecord({ term: 'API', readings: ['えーぴーあい'], summary: '窓口。', field: 'ソフトウェア', origin: 'ai', now: 1 });

    const file = buildLocalTermsFile([term], '2026-07-30');

    expect(file.terms[0].tags).toBeUndefined();
  });
});

describe('validateLocalTermsFile', () => {
  it('accepts a well-formed file', () => {
    const result = validateLocalTermsFile({
      schemaVersion: 1,
      version: '2026-07-30',
      terms: [{ term: 'CORS', readings: ['シーオーアールエス'], summary: '仕組み。', field: 'セキュリティ' }],
    });

    expect(result.ok).toBe(true);
  });

  it('accepts an empty summary (null-summary backward compatibility)', () => {
    const result = validateLocalTermsFile({
      schemaVersion: 1,
      version: '2026-07-30',
      terms: [{ term: 'MTU', readings: ['えむてぃーゆー'], summary: '', field: 'ネットワーク' }],
    });

    expect(result.ok).toBe(true);
  });

  it('rejects an unknown field', () => {
    const result = validateLocalTermsFile({
      schemaVersion: 1,
      version: '2026-07-30',
      terms: [{ term: 'CORS', readings: ['シーオーアールエス'], summary: '仕組み。', field: '存在しない分野' }],
    });

    expect(result.ok).toBe(false);
  });

  it('rejects a missing summary field entirely', () => {
    const result = validateLocalTermsFile({
      schemaVersion: 1,
      version: '2026-07-30',
      terms: [{ term: 'CORS', readings: ['シーオーアールエス'], field: 'セキュリティ' }],
    });

    expect(result.ok).toBe(false);
  });

  it('rejects duplicate terms', () => {
    const result = validateLocalTermsFile({
      schemaVersion: 1,
      version: '2026-07-30',
      terms: [
        { term: 'CORS', readings: ['シーオーアールエス'], summary: '仕組み。', field: 'セキュリティ' },
        { term: 'CORS', readings: ['シーオーアールエス'], summary: '仕組み。', field: 'セキュリティ' },
      ],
    });

    expect(result.ok).toBe(false);
  });

  it('rejects an unknown schemaVersion', () => {
    const result = validateLocalTermsFile({ schemaVersion: 999, version: '2026-07-30', terms: [] });

    expect(result.ok).toBe(false);
  });
});
