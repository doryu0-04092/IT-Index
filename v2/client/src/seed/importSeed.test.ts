import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { ItIndexDB } from '../db';
import { createSettingsRepository } from '../repositories/settings';
import { createTermsRepository } from '../repositories/terms';
import { importSeed } from './importSeed';

function makeDb(): ItIndexDB {
  return new ItIndexDB(`test-seed-${Math.random()}`);
}

const validSeed = {
  schemaVersion: 1,
  version: 'v1',
  terms: [{ term: 'テスト', readings: ['テスト'], summary: '概要', field: '基礎理論' }],
};

describe('importSeed', () => {
  const dbs: ItIndexDB[] = [];
  afterEach(() => {
    for (const db of dbs) db.close();
    dbs.length = 0;
  });

  function repos() {
    const db = makeDb();
    dbs.push(db);
    return { db, termsRepo: createTermsRepository(db), settingsRepo: createSettingsRepository(db) };
  }

  it('検証に通れば取り込み、versionを記録する', async () => {
    const { db, termsRepo, settingsRepo } = repos();
    const result = await importSeed(() => Promise.resolve(validSeed), termsRepo, settingsRepo);

    expect(result).toEqual({ imported: true });
    expect(await db.terms.count()).toBe(1);
    expect((await settingsRepo.get()).seedVersion).toBe('v1');
  });

  it('同じversionなら再取り込みしない', async () => {
    const { db, termsRepo, settingsRepo } = repos();
    await importSeed(() => Promise.resolve(validSeed), termsRepo, settingsRepo);
    await db.terms.clear(); // 再取り込みが起きればこの語が復活するはず

    const result = await importSeed(() => Promise.resolve(validSeed), termsRepo, settingsRepo);

    expect(result).toEqual({ imported: false, reason: 'already up to date' });
    expect(await db.terms.count()).toBe(0);
  });

  it('検証に通らなければ中止し、既存データを保持する', async () => {
    const { db, termsRepo, settingsRepo } = repos();
    await importSeed(() => Promise.resolve(validSeed), termsRepo, settingsRepo);
    const before = await db.terms.count();

    const invalid = { schemaVersion: 1, version: 'v2', terms: [{ term: '', readings: [], summary: '', field: '基礎理論' }] };
    const result = await importSeed(() => Promise.resolve(invalid), termsRepo, settingsRepo);

    expect(result.imported).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(await db.terms.count()).toBe(before); // 既存データが保持されている
    expect((await settingsRepo.get()).seedVersion).toBe('v1'); // versionも更新されない
  });
});
