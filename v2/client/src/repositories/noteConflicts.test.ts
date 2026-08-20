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

const EVENT = 'event-1';

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

  it('addは検出時点のlocal/remoteをそのまま保存し、未解決(resolution:null)・同期イベント付きで返す', async () => {
    const r = repo();
    const conflict = makeConflict();

    const record = await r.add(conflict, 'device-2', 1000, EVENT);

    expect(record.termId).toBe('term-a');
    expect(record.peerDeviceId).toBe('device-2');
    expect(record.resolution).toBeNull();
    expect(record.closedReason).toBeNull();
    expect(record.syncEventId).toBe(EVENT);
    expect(record.local.body).toBe('この端末の内容');
    expect(record.remote.body).toBe('相手の端末の内容');
  });

  it('getOpenは未解決かつ未クローズのみ返す', async () => {
    const r = repo();
    const a = await r.add(makeConflict('term-a'), 'device-2', 1000, EVENT);
    const b = await r.add(makeConflict('term-b'), 'device-2', 2000, EVENT);
    await r.add(makeConflict('term-c'), 'device-2', 3000, EVENT);
    await r.setResolution(a.id, 'local', null, 4000);
    await r.closeAuto(b.id, 'superseded', 5000);

    const open = await r.getOpen();
    expect(open.map((c) => c.termId)).toEqual(['term-c']);
  });

  it('findOpenByTermAndPeerは同termId・同peerのopen行だけ返す', async () => {
    const r = repo();
    const a = await r.add(makeConflict('term-a'), 'device-2', 1000, EVENT);
    await r.add(makeConflict('term-a'), 'device-3', 2000, EVENT); // 別peer

    expect((await r.findOpenByTermAndPeer('term-a', 'device-2'))?.id).toBe(a.id);
    expect(await r.findOpenByTermAndPeer('term-b', 'device-2')).toBeUndefined();

    await r.setResolution(a.id, 'local', null, 3000);
    expect(await r.findOpenByTermAndPeer('term-a', 'device-2')).toBeUndefined(); // 解決済みはopenでない
  });

  it('refreshはスナップショット・検出時刻・イベントを差し替え、resetMerged時のみキャッシュを破棄する', async () => {
    const r = repo();
    const record = await r.add(makeConflict(), 'device-2', 1000, EVENT);
    await r.setResolution(record.id, 'merged', { body: '統合結果', diagrams: [] }, 1500);

    const next = makeConflict();
    next.remote = { ...next.remote, body: '相手の新しい内容' };
    await r.refresh(record.id, { local: next.local, remote: next.remote, detectedAt: 2000, syncEventId: 'event-2', resetMerged: true });

    const [updated] = await r.getAllOrdered();
    expect(updated.remote.body).toBe('相手の新しい内容');
    expect(updated.detectedAt).toBe(2000);
    expect(updated.syncEventId).toBe('event-2');
    expect(updated.merged).toBeNull(); // 内容が変わったのでAI統合キャッシュは破棄
  });

  it('refreshはresetMerged:falseならAI統合キャッシュを保つ(内容が変わらない再発)', async () => {
    const r = repo();
    const record = await r.add(makeConflict(), 'device-2', 1000, EVENT);
    const merged = { body: '統合結果', diagrams: [] };
    await r.setResolution(record.id, 'merged', merged, 1500);

    const same = makeConflict();
    await r.refresh(record.id, { local: same.local, remote: same.remote, detectedAt: 2000, syncEventId: 'event-2', resetMerged: false });

    const [updated] = await r.getAllOrdered();
    expect(updated.merged).toEqual(merged); // 再利用できる状態のまま
    expect(updated.detectedAt).toBe(2000);
  });

  it('carryOverはsyncEventIdだけ付け替える', async () => {
    const r = repo();
    const record = await r.add(makeConflict(), 'device-2', 1000, EVENT);

    await r.carryOver(record.id, 'event-2');

    const [updated] = await r.getAllOrdered();
    expect(updated.syncEventId).toBe('event-2');
    expect(updated.detectedAt).toBe(1000); // 検出時刻は変えない
  });

  it('closeAutoは理由と時刻を記録し、resolutionには触れない', async () => {
    const r = repo();
    const record = await r.add(makeConflict(), 'device-2', 1000, EVENT);

    await r.closeAuto(record.id, 'peer-decision', 2000);

    const [updated] = await r.getAllOrdered();
    expect(updated.closedReason).toBe('peer-decision');
    expect(updated.closedAt).toBe(2000);
    expect(updated.resolution).toBeNull();
  });

  it('getBySyncEventIdは指定イベントの行のみ返す', async () => {
    const r = repo();
    await r.add(makeConflict('term-a'), 'device-2', 1000, EVENT);
    await r.add(makeConflict('term-b'), 'device-2', 2000, 'event-2');

    const linked = await r.getBySyncEventId('event-2');
    expect(linked.map((c) => c.termId)).toEqual(['term-b']);
  });

  it('getAllOrderedは検出日時の新しい順で、解決済みも含む', async () => {
    const r = repo();
    await r.add(makeConflict('term-old'), 'device-2', 1000, EVENT);
    await r.add(makeConflict('term-new'), 'device-2', 2000, EVENT);

    const all = await r.getAllOrdered();
    expect(all.map((c) => c.termId)).toEqual(['term-new', 'term-old']);
  });

  it('setResolutionは選択とresolvedAtを記録する', async () => {
    const r = repo();
    const record = await r.add(makeConflict(), 'device-2', 1000, EVENT);

    await r.setResolution(record.id, 'remote', null, 5000);

    const [updated] = await r.getAllOrdered();
    expect(updated.resolution).toBe('remote');
    expect(updated.resolvedAt).toBe(5000);
  });

  it('setResolutionはmergedを渡した時だけキャッシュを更新する(local/remoteへの選び直しで消さない)', async () => {
    const r = repo();
    const record = await r.add(makeConflict(), 'device-2', 1000, EVENT);
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
});
