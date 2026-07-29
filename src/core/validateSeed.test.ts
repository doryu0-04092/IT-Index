import { describe, expect, it } from 'vitest';
import { validateSeedFile } from './validateSeed';

function validFile() {
  return {
    schemaVersion: 1,
    version: '2026-07-27',
    terms: [
      { term: 'API', readings: ['エーピーアイ'], summary: '窓口。', field: 'ソフトウェア' },
      { term: 'TCP/IP', readings: ['ティーシーピーアイピー'], summary: '規約の集まり。', field: 'ネットワーク', tags: ['プロトコル'] },
    ],
  };
}

describe('validateSeedFile', () => {
  it('accepts a well-formed file', () => {
    const result = validateSeedFile(validFile());
    expect(result.ok).toBe(true);
  });

  it('rejects unknown schemaVersion', () => {
    const result = validateSeedFile({ ...validFile(), schemaVersion: 999 });
    expect(result.ok).toBe(false);
  });

  it('rejects missing version', () => {
    const file = validFile() as Record<string, unknown>;
    delete file.version;
    const result = validateSeedFile(file);
    expect(result.ok).toBe(false);
  });

  it('rejects a term with empty readings', () => {
    const file = validFile();
    file.terms[0].readings = [];
    const result = validateSeedFile(file);
    expect(result.ok).toBe(false);
  });

  it('rejects a field outside the fixed list', () => {
    const file = validFile();
    file.terms[0].field = 'そんな分野はない';
    const result = validateSeedFile(file);
    expect(result.ok).toBe(false);
  });

  it('rejects duplicate term and reports which ones', () => {
    const file = validFile();
    file.terms.push({ ...file.terms[0] });
    const result = validateSeedFile(file);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('API');
  });

  it('tags is optional', () => {
    const file = validFile();
    const result = validateSeedFile(file);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.terms[0].tags).toBeUndefined();
  });
});
