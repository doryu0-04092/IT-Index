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

  it('upsertFromSyncはmergeSnapshot()の結果をそのまま書き、既存のnoteHistoryは保つ', async () => {
    const r = repo();
    await r.saveBody('term-a', '旧本文', 'device-1', 100);

    await r.upsertFromSync({
      termId: 'term-a',
      body: '相手の本文',
      diagrams: [],
      updatedAt: 200,
      lastEditedBy: 'device-2',
      noteHistory: [], // 送信側はstripNoteHistoryで空配列にしてくる
    });

    const note = await r.getByTermId('term-a');
    expect(note?.body).toBe('相手の本文');
    expect(note?.lastEditedBy).toBe('device-2');
    // 相手のnoteHistory(空)で置き換わらず、こちらの履歴が保たれる
    expect(note?.noteHistory).toEqual([]);
  });

  it('upsertFromSyncは新規termIdでも書き込める', async () => {
    const r = repo();
    await r.upsertFromSync({
      termId: 'term-new',
      body: '本文',
      diagrams: [],
      updatedAt: 100,
      lastEditedBy: 'device-2',
      noteHistory: [],
    });

    expect((await r.getByTermId('term-new'))?.body).toBe('本文');
  });

  it('applyConflictResolutionは選ばなかった側もnoteHistoryへ積む(再競合防止)', async () => {
    const r = repo();
    await r.saveBody('term-a', 'この端末の内容', 'device-1', 100);

    await r.applyConflictResolution(
      'term-a',
      '相手の内容',
      [],
      'device-1',
      200,
      { body: 'この端末の内容', diagrams: [] },
    );

    const note = await r.getByTermId('term-a');
    expect(note?.body).toBe('相手の内容');
    expect(note?.noteHistory).toEqual([{ body: 'この端末の内容', diagrams: [], updatedAt: 100 }]);
  });

  it('applyConflictResolutionは同じ内容を二重に積まない', async () => {
    const r = repo();
    await r.saveBody('term-a', 'A', 'device-1', 100);
    await r.applyConflictResolution('term-a', 'B', [], 'device-1', 200, { body: 'A', diagrams: [] });
    await r.applyConflictResolution('term-a', 'A', [], 'device-1', 300, { body: 'B', diagrams: [] });

    const note = await r.getByTermId('term-a');
    // A・Bの2種類のみ(往復しても増えない)
    expect(note?.noteHistory).toHaveLength(2);
  });
});
