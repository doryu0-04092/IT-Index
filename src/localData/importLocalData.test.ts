import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ItIndexDB } from '../db';
import { createNotesRepository, type NotesRepository } from '../repositories/notes';
import { buildTermRecord, createTermsRepository, makeTermId, type TermsRepository } from '../repositories/terms';
import { importLocalData } from './importLocalData';

function termsJson(terms: { term: string; readings: string[]; summary: string; field: string; tags?: string[] }[], version = '2026-07-30') {
  return JSON.stringify({ schemaVersion: 1, version, terms });
}

describe('importLocalData', () => {
  let db: ItIndexDB;
  let termsRepo: TermsRepository;
  let notesRepo: NotesRepository;

  beforeEach(() => {
    db = new ItIndexDB(`test-import-local-${crypto.randomUUID()}`);
    termsRepo = createTermsRepository(db);
    notesRepo = createNotesRepository(db);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('does nothing when terms.json does not exist yet', async () => {
    const result = await importLocalData({ termsJson: undefined, notes: [] }, { termsRepo, notesRepo, deviceId: 'device-A' });

    expect(result.ok).toBe(true);
    expect(result.addedTerms).toBe(0);
  });

  it('adds a new origin:ai term from the file', async () => {
    const json = termsJson([{ term: 'CORS', readings: ['シーオーアールエス'], summary: '仕組み。', field: 'セキュリティ' }]);

    const result = await importLocalData({ termsJson: json, notes: [] }, { termsRepo, notesRepo, deviceId: 'device-A' });

    expect(result.ok).toBe(true);
    expect(result.addedTerms).toBe(1);
    const created = await termsRepo.getById(makeTermId('CORS'));
    expect(created?.origin).toBe('ai');
    expect(created?.summary).toBe('仕組み。');
  });

  it('updates readings/field/tags but never overwrites summary (immutability rule)', async () => {
    const existing = buildTermRecord({
      term: 'CORS',
      readings: ['古い読み'],
      summary: '元の要約。',
      field: 'AI',
      origin: 'ai',
      now: 1,
    });
    await termsRepo.upsertFromAi(existing);

    const json = termsJson([
      { term: 'CORS', readings: ['シーオーアールエス'], summary: '書き換えようとした要約。', field: 'セキュリティ', tags: ['CORS関連'] },
    ]);

    const result = await importLocalData({ termsJson: json, notes: [] }, { termsRepo, notesRepo, deviceId: 'device-A' }, 100);

    expect(result.updatedTerms).toBe(1);
    const updated = await termsRepo.getById(existing.id);
    expect(updated?.readings).toEqual(['シーオーアールエス']);
    expect(updated?.field).toBe('セキュリティ');
    expect(updated?.tags).toEqual(['CORS関連']);
    expect(updated?.summary).toBe('元の要約。'); // 不変ルール: ファイル側の値は無視される
  });

  it('tombstones an origin:ai term that disappeared from the file (within the safeguard threshold)', async () => {
    const existing = buildTermRecord({ term: 'CORS', readings: ['x'], summary: 's', field: 'セキュリティ', origin: 'ai', now: 1 });
    await termsRepo.upsertFromAi(existing);

    const result = await importLocalData(
      { termsJson: termsJson([]), notes: [] },
      { termsRepo, notesRepo, deviceId: 'device-A' },
      100,
    );

    expect(result.ok).toBe(true);
    expect(result.tombstonedTerms).toBe(1);
    expect((await termsRepo.getById(existing.id))?.deletedAt).toBe(100); // tombstone。レコード自体は残る
    expect((await termsRepo.getAll()).map((t) => t.id)).not.toContain(existing.id); // getAll は deletedAt を除外する
  });

  it('does not touch origin:seed terms even if absent from the file', async () => {
    const seedTerm = buildTermRecord({ term: 'API', readings: ['x'], summary: 's', field: 'ソフトウェア', origin: 'seed', now: 1 });
    await termsRepo.bulkPutFromSeed([seedTerm]);

    const result = await importLocalData({ termsJson: termsJson([]), notes: [] }, { termsRepo, notesRepo, deviceId: 'device-A' });

    expect(result.ok).toBe(true);
    expect(result.tombstonedTerms).toBe(0);
    expect((await termsRepo.getById(seedTerm.id))?.deletedAt).toBeNull();
  });

  it('aborts when the number of removed terms exceeds the safeguard threshold', async () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      buildTermRecord({ term: `語${i}`, readings: ['x'], summary: 's', field: 'AI', origin: 'ai', now: 1 }),
    );
    for (const t of many) await termsRepo.upsertFromAi(t);

    const result = await importLocalData({ termsJson: termsJson([]), notes: [] }, { termsRepo, notesRepo, deviceId: 'device-A' });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/誤削除/);
    // 中止したので既存データは残っている
    expect((await termsRepo.getAll()).filter((t) => t.deletedAt === null)).toHaveLength(25);
  });

  it('aborts on invalid JSON without touching existing data', async () => {
    const existing = buildTermRecord({ term: 'CORS', readings: ['x'], summary: 's', field: 'セキュリティ', origin: 'ai', now: 1 });
    await termsRepo.upsertFromAi(existing);

    const result = await importLocalData({ termsJson: '{ broken', notes: [] }, { termsRepo, notesRepo, deviceId: 'device-A' });

    expect(result.ok).toBe(false);
    expect(await termsRepo.getById(existing.id)).toEqual(existing);
  });

  it('aborts when validation fails (unknown field)', async () => {
    const json = termsJson([{ term: 'X', readings: ['x'], summary: 's', field: '存在しない分野' }]);

    const result = await importLocalData({ termsJson: json, notes: [] }, { termsRepo, notesRepo, deviceId: 'device-A' });

    expect(result.ok).toBe(false);
    expect(await termsRepo.getById(makeTermId('X'))).toBeUndefined();
  });

  it('applies a note file for a known term', async () => {
    const existing = buildTermRecord({ term: 'CORS', readings: ['x'], summary: 's', field: 'セキュリティ', origin: 'ai', now: 1 });
    await termsRepo.upsertFromAi(existing);

    const noteContent = `---\nterm: CORS\n---\n\n本文です。\n\n\`\`\`mermaid\ngraph LR\n  A --> B\n\`\`\`\n`;

    const result = await importLocalData(
      { termsJson: termsJson([]), notes: [{ termId: existing.id, content: noteContent }] },
      { termsRepo, notesRepo, deviceId: 'device-A' },
    );

    expect(result.appliedNotes).toBe(1);
    const note = await notesRepo.getByTermId(existing.id);
    expect(note?.body).toBe('本文です。');
    expect(note?.diagrams).toEqual(['graph LR\n  A --> B']);
  });

  it('skips a note file whose termId does not match any known term', async () => {
    const result = await importLocalData(
      { termsJson: termsJson([]), notes: [{ termId: 'unknown-term', content: '本文' }] },
      { termsRepo, notesRepo, deviceId: 'device-A' },
    );

    expect(result.appliedNotes).toBe(0);
    expect(result.skippedNotes).toEqual(['unknown-term']);
  });

  it('applies notes for terms added in the same import pass', async () => {
    const json = termsJson([{ term: 'CORS', readings: ['シーオーアールエス'], summary: '仕組み。', field: 'セキュリティ' }]);
    const noteContent = `本文です。`;

    const result = await importLocalData(
      { termsJson: json, notes: [{ termId: makeTermId('CORS'), content: noteContent }] },
      { termsRepo, notesRepo, deviceId: 'device-A' },
    );

    expect(result.addedTerms).toBe(1);
    expect(result.appliedNotes).toBe(1);
  });
});
