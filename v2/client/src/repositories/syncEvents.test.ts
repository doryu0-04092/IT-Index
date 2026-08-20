import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { ItIndexDB } from '../db';
import { createSyncEventsRepository } from './syncEvents';
import type { SyncEventRecord } from '../types';

/**
 * 同期実行の記録(#157で追加、#171でテストを追加)。競合(noteConflicts.syncEventId)が
 * ここへリンクするため、「最新の同期はどれか」「新しい順にn件」が正しいことが
 * 同期画面(直近の競合だけを出す)と履歴画面(連携履歴)の前提になる。
 */
function makeEvent(id: string, at: number, overrides: Partial<SyncEventRecord> = {}): SyncEventRecord {
  return {
    id,
    at,
    pushedSeq: 1,
    receivedBlobs: 0,
    skippedBlobs: 0,
    conflictCount: 0,
    peerDeviceIds: [],
    completed: false,
    ...overrides,
  };
}

describe('createSyncEventsRepository', () => {
  const dbs: ItIndexDB[] = [];
  afterEach(() => {
    for (const db of dbs) db.close();
    dbs.length = 0;
  });

  function repo() {
    const db = new ItIndexDB(`test-syncEvents-${Math.random()}`);
    dbs.push(db);
    return createSyncEventsRepository(db);
  }

  it('記録が無ければgetLatestはundefinedを返す(初回起動時)', async () => {
    expect(await repo().getLatest()).toBeUndefined();
  });

  it('getLatestは最も新しい(at最大の)記録を返す', async () => {
    const r = repo();
    await r.put(makeEvent('old', 1000));
    await r.put(makeEvent('new', 3000));
    await r.put(makeEvent('mid', 2000));

    expect((await r.getLatest())?.id).toBe('new');
  });

  it('getRecentは新しい順で、limit件までに絞る', async () => {
    const r = repo();
    await r.put(makeEvent('e1', 1000));
    await r.put(makeEvent('e2', 2000));
    await r.put(makeEvent('e3', 3000));

    expect((await r.getRecent(2)).map((e) => e.id)).toEqual(['e3', 'e2']);
    expect((await r.getRecent(10)).map((e) => e.id)).toEqual(['e3', 'e2', 'e1']);
  });

  it('updateOutcomeは結果だけを更新し、id・at・pushedSeqは変えない', async () => {
    const r = repo();
    await r.put(makeEvent('e1', 1000, { pushedSeq: 42 }));

    await r.updateOutcome('e1', {
      receivedBlobs: 3,
      skippedBlobs: 1,
      conflictCount: 2,
      peerDeviceIds: ['device-2', 'device-3'],
      completed: true,
    });

    const updated = await r.getLatest();
    expect(updated).toMatchObject({
      id: 'e1',
      at: 1000,
      pushedSeq: 42, // pushの記録は保たれる
      receivedBlobs: 3,
      skippedBlobs: 1,
      conflictCount: 2,
      completed: true,
    });
    expect(updated?.peerDeviceIds).toEqual(['device-2', 'device-3']);
  });

  it('同じidでputすると上書きされる(重複レコードを作らない)', async () => {
    const r = repo();
    await r.put(makeEvent('e1', 1000));
    await r.put(makeEvent('e1', 1000, { receivedBlobs: 5 }));

    const all = await r.getRecent(10);
    expect(all).toHaveLength(1);
    expect(all[0].receivedBlobs).toBe(5);
  });
});
