// 実機報告「削除→AI再取り込みが相手端末に渡らない」の回帰テスト(#179)。
// 調査(2026-08-20)では取り込み時の自動push(#177)込みで全シナリオ正常。自動pushが
// 無い/失敗した場合に実機の症状と同型になるため、両方向4シナリオを固定する。
import 'fake-indexeddb/auto';
import { buildTermRecord } from '@it-index/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ItIndexDB } from '../db';
import { createAsksRepository } from '../repositories/asks';
import { createNoteConflictsRepository } from '../repositories/noteConflicts';
import { createNotesRepository } from '../repositories/notes';
import { createSyncEventsRepository } from '../repositories/syncEvents';
import { createSyncStateRepository } from '../repositories/syncState';
import { createTermsRepository } from '../repositories/terms';
import { generateDataKey } from './syncCrypto';
import { setDataKey } from './syncKeyStore';
import { pushToRelay, runSync, type SyncEngineDeps } from './syncEngine';

function makeDeps(deviceId: string, holdLocalOnConflict: boolean): SyncEngineDeps {
  const db = new ItIndexDB(`test-inv179-${Math.random()}`);
  // 同期の前提として鍵を用意する(#226。エンジンは鍵を自動生成しなくなった)
  setDataKey('test-account', generateDataKey());
  return {
    db,
    termsRepo: createTermsRepository(db),
    notesRepo: createNotesRepository(db),
    asksRepo: createAsksRepository(db),
    noteConflictsRepo: createNoteConflictsRepository(db),
    syncEventsRepo: createSyncEventsRepository(db),
    syncStateRepo: createSyncStateRepository(db),
    accountId: 'test-account',
    deviceId,
    holdLocalOnConflict,
  };
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

function makeRelay() {
  const blobs: { seq: number; deviceId: string; payload: string; createdAt: number }[] = [];
  const fetchMock = vi.fn().mockImplementation((url: string, init?: { body?: string }) => {
    if (url === '/api/sync/push') {
      const body = JSON.parse(String(init?.body));
      const seq = blobs.length + 1;
      blobs.push({ seq, deviceId: body.deviceId, payload: body.payload, createdAt: seq });
      return Promise.resolve(jsonResponse(201, { seq }));
    }
    const since = Number(new URL(url, 'http://localhost').searchParams.get('since'));
    return Promise.resolve(jsonResponse(200, { blobs: blobs.filter((b) => b.seq > since), latest: blobs.length }));
  });
  return { blobs, fetchMock };
}

/** AI取り込み(writeTerms)相当のDB書き込み。termIdはbuildTermRecordが正規化から作る */
async function aiCommit(deps: SyncEngineDeps, term: string, noteBody: string, now: number) {
  const record = buildTermRecord({
    term,
    readings: [term],
    summary: null,
    field: 'セキュリティ',
    origin: 'ai',
    now,
  });
  await deps.termsRepo.upsertFromAi(record);
  await deps.notesRepo.applyCommit(record.id, noteBody, [], deps.deviceId, now);
  return record.id;
}

describe('削除→再取り込みの伝播(#179回帰)', () => {
  const dbs: ItIndexDB[] = [];
  function track(deps: SyncEngineDeps): SyncEngineDeps {
    dbs.push(deps.db);
    return deps;
  }
  afterEach(() => {
    for (const db of dbs) db.close();
    dbs.length = 0;
    vi.unstubAllGlobals();
  });

  it('S1: Androidが削除→再取り込み(自動push)→PCの同期1回で再取り込み後の内容が届く', async () => {
    const relay = makeRelay();
    vi.stubGlobal('fetch', relay.fetchMock);
    const pc = track(makeDeps('device-pc', false));
    const android = track(makeDeps('device-an', true));

    // Androidで取り込み→自動push→両端末が同期して揃う
    const termId = await aiCommit(android, 'ゼロトラスト', '最初の説明', 1000);
    await pushToRelay(android, 'tok');
    await runSync(pc, 'tok');
    expect((await pc.termsRepo.getById(termId))?.term).toBe('ゼロトラスト');
    await runSync(android, 'tok');

    // Androidで削除→AI検索で再取り込み→自動push(#177)
    await android.termsRepo.softDelete(termId, 2000);
    await aiCommit(android, 'ゼロトラスト', '再取り込み後の説明', 3000);
    await pushToRelay(android, 'tok');

    // PCの次の同期1回で、再取り込み後の内容が届くはず
    await runSync(pc, 'tok');

    const term = await pc.termsRepo.getById(termId);
    expect(term?.term).toBe('ゼロトラスト'); // 生きている(削除扱いになっていない)
    expect((await pc.notesRepo.getByTermId(termId))?.body).toBe('再取り込み後の説明');
  });

  it('S2: 削除が一度同期で両端末に渡った後に再取り込み→PCで復活する', async () => {
    const relay = makeRelay();
    vi.stubGlobal('fetch', relay.fetchMock);
    const pc = track(makeDeps('device-pc', false));
    const android = track(makeDeps('device-an', true));

    const termId = await aiCommit(android, 'ゼロトラスト', '最初の説明', 1000);
    await pushToRelay(android, 'tok');
    await runSync(pc, 'tok');
    await runSync(android, 'tok');

    // 削除を同期で両端末に行き渡らせる
    await android.termsRepo.softDelete(termId, 2000);
    await runSync(android, 'tok');
    await runSync(pc, 'tok');
    expect(await pc.termsRepo.getById(termId)).toBeUndefined(); // PCでも削除済み

    // Androidで再取り込み→自動push→PCの同期1回
    await aiCommit(android, 'ゼロトラスト', '再取り込み後の説明', 4000);
    await pushToRelay(android, 'tok');
    await runSync(pc, 'tok');

    expect((await pc.termsRepo.getById(termId))?.term).toBe('ゼロトラスト');
    expect((await pc.notesRepo.getByTermId(termId))?.body).toBe('再取り込み後の説明');
  });

  it('S3: 両端末が独自に同じ語を取り込み→Androidが削除→再取り込み→PCに競合として確立される', async () => {
    const relay = makeRelay();
    vi.stubGlobal('fetch', relay.fetchMock);
    const pc = track(makeDeps('device-pc', false));
    const android = track(makeDeps('device-an', true));

    // 両端末が独自に同じ語を取り込む(idは正規化から作られるため同一になる)
    const termId = await aiCommit(android, 'ゼロトラスト', 'Android側の説明', 1000);
    await pushToRelay(android, 'tok');
    await aiCommit(pc, 'ゼロトラスト', 'PC側の説明', 2000);
    await pushToRelay(pc, 'tok');

    // Androidで削除→再取り込み→自動push
    await android.termsRepo.softDelete(termId, 3000);
    await aiCommit(android, 'ゼロトラスト', 'Android再取り込みの説明', 4000);
    await pushToRelay(android, 'tok');

    // PCの同期1回: Android側の情報が競合として確立され、解消できる状態になるはず
    await runSync(pc, 'tok');

    const open = await pc.noteConflictsRepo.getOpen();
    expect(open).toHaveLength(1);
    expect(open[0].remote.body).toBe('Android再取り込みの説明'); // 最新版が競合相手
    // LWWでは新しい方が先に採用されている(PC画面から解消で選び直せる)
    expect((await pc.notesRepo.getByTermId(termId))?.body).toBe('Android再取り込みの説明');
  });

  it('S4: PC側が削除→再取り込みした場合も、Androidの同期1回で届く(方向の対称性)', async () => {
    const relay = makeRelay();
    vi.stubGlobal('fetch', relay.fetchMock);
    const pc = track(makeDeps('device-pc', false));
    const android = track(makeDeps('device-an', true));

    const termId = await aiCommit(pc, 'ゼロトラスト', '最初の説明', 1000);
    await pushToRelay(pc, 'tok');
    await runSync(android, 'tok');
    await runSync(pc, 'tok');

    // PCで削除→再取り込み→自動push
    await pc.termsRepo.softDelete(termId, 2000);
    await aiCommit(pc, 'ゼロトラスト', 'PC再取り込みの説明', 3000);
    await pushToRelay(pc, 'tok');

    // Androidの同期1回で届く(Androidは編集していないので競合にはならず、そのまま採用)
    await runSync(android, 'tok');

    expect((await android.termsRepo.getById(termId))?.term).toBe('ゼロトラスト');
    expect((await android.notesRepo.getByTermId(termId))?.body).toBe('PC再取り込みの説明');
  });
});
