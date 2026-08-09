import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { ItIndexDB } from '../db';
import { createNoteConflictsRepository, type NoteConflict } from './noteConflicts';

function makeDb(): ItIndexDB {
  return new ItIndexDB(`test-noteConflicts-${Math.random()}`);
}

function makeConflict(termId = 'term-a'): NoteConflict {
  const base = { termId, diagrams: [], noteHistory: [] };
  return {
    termId,
    local: { ...base, body: 'この端末の内容', updatedAt: 100, lastEditedBy: 'device-1' },
    remote: { ...base, body: '相手の端末の内容', updatedAt: 200, lastEditedBy: 'device-2' },
  };
}

describe('createNoteConflictsRepository', () => {
  const dbs: ItIndexDB[] = [];
  afterEach(() => {
    for (const db of dbs) db.close();
    dbs.length = 0;
  });

  function repo() {
    const db = makeDb();
    dbs.push(db);
    return createNoteConflictsRepository(db);
  }

  it('addは検出時点のlocal/remoteをそのまま保存し、未解決(resolution:null)で返す', async () => {
    const r = repo();
    const conflict = makeConflict();

    const record = await r.add(conflict, 'device-2', 1000);

    expect(record.termId).toBe('term-a');
    expect(record.peerDeviceId).toBe('device-2');
    expect(record.resolution).toBeNull();
    expect(record.local.body).toBe('この端末の内容');
    expect(record.remote.body).toBe('相手の端末の内容');
  });

  it('getUnresolvedはresolution:nullのみ返す', async () => {
    const r = repo();
    const a = await r.add(makeConflict('term-a'), 'device-2', 1000);
    await r.add(makeConflict('term-b'), 'device-2', 2000);
    await r.setResolution(a.id, 'local', 3000);

    const unresolved = await r.getUnresolved();
    expect(unresolved.map((c) => c.termId)).toEqual(['term-b']);
  });

  it('getAllOrderedは検出日時の新しい順で、解決済みも含む', async () => {
    const r = repo();
    await r.add(makeConflict('term-old'), 'device-2', 1000);
    await r.add(makeConflict('term-new'), 'device-2', 2000);

    const all = await r.getAllOrdered();
    expect(all.map((c) => c.termId)).toEqual(['term-new', 'term-old']);
  });

  it('setResolutionは選択とresolvedAtを記録する', async () => {
    const r = repo();
    const record = await r.add(makeConflict(), 'device-2', 1000);

    await r.setResolution(record.id, 'remote', 5000);

    const [updated] = await r.getAllOrdered();
    expect(updated.resolution).toBe('remote');
    expect(updated.resolvedAt).toBe(5000);
  });
});
