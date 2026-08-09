import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { ItIndexDB } from '../db';
import { createNotesRepository } from './notes';

function makeDb(): ItIndexDB {
  return new ItIndexDB(`test-notes-${Math.random()}`);
}

describe('createNotesRepository', () => {
  const dbs: ItIndexDB[] = [];
  afterEach(() => {
    for (const db of dbs) db.close();
    dbs.length = 0;
  });

  function repo() {
    const db = makeDb();
    dbs.push(db);
    return createNotesRepository(db);
  }

  it('新規保存はnoteHistoryが空になる', async () => {
    const r = repo();
    await r.saveBody('term-a', '本文1', 'device-1', 100);

    const note = await r.getByTermId('term-a');
    expect(note?.body).toBe('本文1');
    expect(note?.noteHistory).toEqual([]);
  });

  it('上書き保存すると旧内容がnoteHistoryへ退避される', async () => {
    const r = repo();
    await r.saveBody('term-a', '本文1', 'device-1', 100);
    await r.saveBody('term-a', '本文2', 'device-1', 200);

    const note = await r.getByTermId('term-a');
    expect(note?.body).toBe('本文2');
    expect(note?.noteHistory).toEqual([{ body: '本文1', diagrams: [], updatedAt: 100 }]);
  });

  it('getAllは全termIdのノートを返す', async () => {
    const r = repo();
    await r.saveBody('term-a', 'a', 'device-1', 100);
    await r.saveBody('term-b', 'b', 'device-1', 100);

    const all = await r.getAll();
    expect(all.map((n) => n.termId).sort()).toEqual(['term-a', 'term-b']);
  });
});
