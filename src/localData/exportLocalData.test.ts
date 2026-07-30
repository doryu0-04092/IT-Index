import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ItIndexDB } from '../db';
import { createNotesRepository, type NotesRepository } from '../repositories/notes';
import { buildTermRecord, createTermsRepository, type TermsRepository } from '../repositories/terms';
import { buildLocalDataExport } from './exportLocalData';

describe('buildLocalDataExport', () => {
  let db: ItIndexDB;
  let termsRepo: TermsRepository;
  let notesRepo: NotesRepository;

  beforeEach(() => {
    db = new ItIndexDB(`test-export-local-${crypto.randomUUID()}`);
    termsRepo = createTermsRepository(db);
    notesRepo = createNotesRepository(db);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('includes only origin:ai terms in terms.json', async () => {
    const aiTerm = buildTermRecord({ term: 'CORS', readings: ['x'], summary: 's', field: 'セキュリティ', origin: 'ai', now: 1 });
    const seedTerm = buildTermRecord({ term: 'API', readings: ['x'], summary: 's', field: 'ソフトウェア', origin: 'seed', now: 1 });
    await termsRepo.upsertFromAi(aiTerm);
    await termsRepo.bulkPutFromSeed([seedTerm]);

    const result = await buildLocalDataExport({ termsRepo, notesRepo }, '2026-07-30');

    const parsed = JSON.parse(result.termsJson);
    expect(parsed.terms.map((t: { term: string }) => t.term)).toEqual(['CORS']);
  });

  it('includes notes for both seed and ai terms, but only when they have content', async () => {
    const seedTerm = buildTermRecord({ term: 'API', readings: ['x'], summary: 's', field: 'ソフトウェア', origin: 'seed', now: 1 });
    const emptyNoteTerm = buildTermRecord({ term: 'TCP', readings: ['x'], summary: 's', field: 'ネットワーク', origin: 'seed', now: 1 });
    await termsRepo.bulkPutFromSeed([seedTerm, emptyNoteTerm]);
    await notesRepo.applyCommit(seedTerm.id, '窓口という説明。', [], 'device-A', 2);
    await notesRepo.applyCommit(emptyNoteTerm.id, '', [], 'device-A', 2); // 空本文は書き出さない

    const result = await buildLocalDataExport({ termsRepo, notesRepo }, '2026-07-30');

    expect(result.notes.map((n) => n.termId)).toEqual([seedTerm.id]);
    expect(result.notes[0].content).toContain('窓口という説明。');
  });

  it('omits notes whose term is tombstoned (getAll excludes deletedAt terms)', async () => {
    const term = buildTermRecord({ term: 'CORS', readings: ['x'], summary: 's', field: 'セキュリティ', origin: 'ai', now: 1 });
    await termsRepo.upsertFromAi(term);
    await notesRepo.applyCommit(term.id, '本文', [], 'device-A', 2);
    await termsRepo.upsertFromAi({ ...term, deletedAt: 3 }); // 削除（tombstone）

    const result = await buildLocalDataExport({ termsRepo, notesRepo }, '2026-07-30');

    expect(result.notes.map((n) => n.termId)).not.toContain(term.id);
  });
});
