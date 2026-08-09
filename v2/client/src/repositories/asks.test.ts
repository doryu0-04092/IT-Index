import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { ItIndexDB } from '../db';
import { createAsksRepository } from './asks';

function makeDb(): ItIndexDB {
  return new ItIndexDB(`test-asks-${Math.random()}`);
}

describe('createAsksRepository', () => {
  const dbs: ItIndexDB[] = [];
  afterEach(() => {
    for (const db of dbs) db.close();
    dbs.length = 0;
  });

  function repo() {
    const db = makeDb();
    dbs.push(db);
    return createAsksRepository(db);
  }

  it('addSearchConfirmはsource:searchのレコードを追加する', async () => {
    const r = repo();
    await r.addSearchConfirm('term-a', 'device-1', 1000);

    const asks = await r.getByTermId('term-a');
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ termId: 'term-a', sessionId: null, at: 1000, deviceId: 'device-1', source: 'search' });
  });

  it('getAllOrderedはat昇順、同at時はid昇順で返す(compound indexが無いためJSソートで代替)', async () => {
    const r = repo();
    await r.addSearchConfirm('term-b', 'device-1', 2000);
    await r.addSearchConfirm('term-a', 'device-1', 1000);
    await r.addSearchConfirm('term-c', 'device-1', 1000);

    const ordered = await r.getAllOrdered();
    expect(ordered.map((a) => a.at)).toEqual([1000, 1000, 2000]);
    // at:1000の2件はid昇順
    expect(ordered[0].id < ordered[1].id).toBe(true);
  });

  it('upsertFromSyncはidの和集合として追加する(既存分は上書きしない・冪等)', async () => {
    const r = repo();
    await r.addSearchConfirm('term-a', 'device-1', 1000);
    const existing = await r.getByTermId('term-a');

    await r.upsertFromSync([
      existing[0], // 既存分。再度渡しても増えない
      { id: 'ask-remote-1', termId: 'term-b', sessionId: null, at: 2000, deviceId: 'device-2', source: 'ai' },
    ]);
    await r.upsertFromSync([
      { id: 'ask-remote-1', termId: 'term-b', sessionId: null, at: 2000, deviceId: 'device-2', source: 'ai' },
    ]);

    const all = await r.getAllOrdered();
    expect(all.map((a) => a.id).sort()).toEqual(['ask-remote-1', existing[0].id].sort());
  });
});
