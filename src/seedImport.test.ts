import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ItIndexDB } from './db';
import { createTermsRepository } from './repositories/terms';
import { createSettingsRepository } from './repositories/settings';
import { importSeed } from './seedImport';

function seedFile(version: string) {
  return {
    schemaVersion: 1,
    version,
    terms: [{ term: 'API', readings: ['エーピーアイ'], summary: '窓口。', field: 'ソフトウェア' }],
  };
}

describe('importSeed', () => {
  let db: ItIndexDB;

  beforeEach(() => {
    db = new ItIndexDB(`test-seed-${crypto.randomUUID()}`);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('imports terms and records the seed version on first run', async () => {
    const termsRepo = createTermsRepository(db);
    const settingsRepo = createSettingsRepository(db);

    const result = await importSeed(async () => seedFile('2026-07-27'), termsRepo, settingsRepo);

    expect(result.imported).toBe(true);
    expect((await termsRepo.getAll()).map((t) => t.term)).toEqual(['API']);
    expect((await settingsRepo.get()).seedVersion).toBe('2026-07-27');
  });

  it('does nothing when the version has not changed', async () => {
    const termsRepo = createTermsRepository(db);
    const settingsRepo = createSettingsRepository(db);

    await importSeed(async () => seedFile('2026-07-27'), termsRepo, settingsRepo);
    const second = await importSeed(async () => seedFile('2026-07-27'), termsRepo, settingsRepo);

    expect(second.imported).toBe(false);
    expect(second.reason).toBe('already up to date');
  });

  it('re-imports when the version changes', async () => {
    const termsRepo = createTermsRepository(db);
    const settingsRepo = createSettingsRepository(db);

    await importSeed(async () => seedFile('2026-07-27'), termsRepo, settingsRepo);
    const second = await importSeed(
      async () => ({
        schemaVersion: 1,
        version: '2026-08-01',
        terms: [
          { term: 'API', readings: ['エーピーアイ'], summary: '窓口。', field: 'ソフトウェア' },
          { term: 'TCP/IP', readings: ['ティーシーピーアイピー'], summary: '規約の集まり。', field: 'ネットワーク' },
        ],
      }),
      termsRepo,
      settingsRepo,
    );

    expect(second.imported).toBe(true);
    expect((await termsRepo.getAll())).toHaveLength(2);
    expect((await settingsRepo.get()).seedVersion).toBe('2026-08-01');
  });

  it('aborts and keeps existing data when validation fails', async () => {
    const termsRepo = createTermsRepository(db);
    const settingsRepo = createSettingsRepository(db);

    await importSeed(async () => seedFile('2026-07-27'), termsRepo, settingsRepo);
    const broken = await importSeed(async () => ({ schemaVersion: 999, version: 'x', terms: [] }), termsRepo, settingsRepo);

    expect(broken.imported).toBe(false);
    expect((await termsRepo.getAll()).map((t) => t.term)).toEqual(['API']); // 既存データが残っている
    expect((await settingsRepo.get()).seedVersion).toBe('2026-07-27'); // version も更新されていない
  });
});
