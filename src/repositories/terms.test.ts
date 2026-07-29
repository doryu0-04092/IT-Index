import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ItIndexDB } from '../db';
import { buildTermRecord, createTermsRepository } from './terms';

describe('TermsRepository', () => {
  let db: ItIndexDB;

  beforeEach(() => {
    db = new ItIndexDB(`test-terms-${crypto.randomUUID()}`);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('getAll excludes tombstoned records', async () => {
    const repo = createTermsRepository(db);
    const now = Date.now();
    const alive = buildTermRecord({ term: 'API', readings: ['エーピーアイ'], summary: '', field: 'ソフトウェア', origin: 'seed', now });
    const deleted = {
      ...buildTermRecord({ term: 'DEAD', readings: ['デッド'], summary: '', field: 'ソフトウェア', origin: 'seed', now }),
      deletedAt: now,
    };

    await repo.bulkPutFromSeed([alive, deleted]);
    const all = await repo.getAll();

    expect(all.map((t) => t.id)).toEqual([alive.id]);
  });

  it('makeTermId is derived deterministically from term (normalize)', async () => {
    const repo = createTermsRepository(db);
    const now = Date.now();
    const term = buildTermRecord({ term: 'TCP/IP', readings: ['ティーシーピーアイピー'], summary: '', field: 'ネットワーク', origin: 'seed', now });

    await repo.bulkPutFromSeed([term]);
    const found = await repo.getById(term.id);

    expect(found?.term).toBe('TCP/IP');
    expect(term.id).toBe('tcp/ip');
  });
});
