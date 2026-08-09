import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTermRecord, type TermRecord } from '@it-index/shared';
import { ItIndexDB } from '../db';
import { createTermsRepository } from './terms';

function makeDb(): ItIndexDB {
  return new ItIndexDB(`test-terms-${Math.random()}`);
}

function makeTerm(overrides: Partial<TermRecord> = {}): TermRecord {
  return {
    ...buildTermRecord({
      term: 'テスト',
      readings: ['テスト'],
      summary: '概要',
      field: '基礎理論',
      origin: 'seed',
      now: 1000,
    }),
    ...overrides,
  };
}

describe('createTermsRepository', () => {
  const dbs: ItIndexDB[] = [];
  afterEach(async () => {
    for (const db of dbs) db.close();
    dbs.length = 0;
  });

  function repo() {
    const db = makeDb();
    dbs.push(db);
    return { db, repo: createTermsRepository(db) };
  }

  it('getAllは削除済み(tombstone)を除く', async () => {
    const { db, repo: r } = repo();
    await db.terms.bulkPut([makeTerm({ id: 'a' }), makeTerm({ id: 'b', deletedAt: 2000 })]);

    const all = await r.getAll();
    expect(all.map((t) => t.id)).toEqual(['a']);
  });

  it('getAllForSyncは削除済みも返す', async () => {
    const { db, repo: r } = repo();
    await db.terms.bulkPut([makeTerm({ id: 'a' }), makeTerm({ id: 'b', deletedAt: 2000 })]);

    const all = await r.getAllForSync();
    expect(all.map((t) => t.id).sort()).toEqual(['a', 'b']);
  });

  it('getByIdは削除済みをundefinedとして返す', async () => {
    const { db, repo: r } = repo();
    await db.terms.put(makeTerm({ id: 'a', deletedAt: 2000 }));

    expect(await r.getById('a')).toBeUndefined();
  });

  it('bulkPutFromSeedは利用者が削除した語のtombstoneを引き継ぎ、シード更新で復活させない', async () => {
    const { db, repo: r } = repo();
    // 利用者が既に削除した語
    await db.terms.put(makeTerm({ id: 'a', deletedAt: 5000 }));

    // シード側は常にdeletedAt:nullで組み立てられる(buildTermRecordの仕様)
    const incoming = makeTerm({ id: 'a', deletedAt: null, updatedAt: 9000 });
    await r.bulkPutFromSeed([incoming]);

    const stored = await db.terms.get('a');
    expect(stored?.deletedAt).toBe(5000); // 復活していない
  });

  it('bulkPutFromSeedは未削除の語をそのまま取り込む', async () => {
    const { repo: r, db } = repo();
    const incoming = makeTerm({ id: 'a', deletedAt: null });
    await r.bulkPutFromSeed([incoming]);

    const stored = await db.terms.get('a');
    expect(stored?.deletedAt).toBeNull();
  });

  it('softDeleteはtombstoneするだけで物理削除しない', async () => {
    const { db, repo: r } = repo();
    await db.terms.put(makeTerm({ id: 'a' }));

    await r.softDelete('a', 12345);

    const stored = await db.terms.get('a');
    expect(stored).toBeDefined();
    expect(stored?.deletedAt).toBe(12345);
  });
});
