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
    await r.setResolution(a.id, 'local', null, 3000);

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

    await r.setResolution(record.id, 'remote', null, 5000);

    const [updated] = await r.getAllOrdered();
    expect(updated.resolution).toBe('remote');
    expect(updated.resolvedAt).toBe(5000);
  });

  it('setResolutionはmergedを渡した時だけキャッシュを更新する(local/remoteへの選び直しで消さない)', async () => {
    const r = repo();
    const record = await r.add(makeConflict(), 'device-2', 1000);
    const merged = { body: '統合された説明', diagrams: [] };

    await r.setResolution(record.id, 'merged', merged, 2000);
    let [updated] = await r.getAllOrdered();
    expect(updated.resolution).toBe('merged');
    expect(updated.merged).toEqual(merged);

    // local へ選び直す(merged は渡さない) -> resolution は変わるが merged キャッシュは残る
    await r.setResolution(record.id, 'local', null, 3000);
    [updated] = await r.getAllOrdered();
    expect(updated.resolution).toBe('local');
    expect(updated.merged).toEqual(merged);
  });

  it('getResolvedはresolution:null以外を解決日時の新しい順で返す', async () => {
    const r = repo();
    const a = await r.add(makeConflict('term-a'), 'device-2', 1000);
    const b = await r.add(makeConflict('term-b'), 'device-2', 2000);
    await r.add(makeConflict('term-c'), 'device-2', 3000); // 未解決のまま

    await r.setResolution(a.id, 'local', null, 5000);
    await r.setResolution(b.id, 'remote', null, 6000);

    const resolved = await r.getResolved();
    expect(resolved.map((c) => c.termId)).toEqual(['term-b', 'term-a']);
  });
});
