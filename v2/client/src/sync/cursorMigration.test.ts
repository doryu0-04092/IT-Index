import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ItIndexDB } from '../db';
import { createAsksRepository } from '../repositories/asks';
import { createNoteConflictsRepository } from '../repositories/noteConflicts';
import { createNotesRepository } from '../repositories/notes';
import { createSyncEventsRepository } from '../repositories/syncEvents';
import { createSyncStateRepository } from '../repositories/syncState';
import { createTermsRepository } from '../repositories/terms';
import { resetSyncCursorOnce } from './cursorMigration';
import { pullFromRelay, type SyncEngineDeps } from './syncEngine';
import { encryptSyncPayload, importDataKey } from './syncCrypto';
import { getOrCreateDataKey } from './syncKeyStore';

const dbs: ItIndexDB[] = [];

function makeRepo() {
  const db = new ItIndexDB(`test-cursorMigration-${Math.random()}`);
  dbs.push(db);
  return { db, syncStateRepo: createSyncStateRepository(db) };
}

function makeDeps(db: ItIndexDB): SyncEngineDeps {
  return {
    db,
    termsRepo: createTermsRepository(db),
    notesRepo: createNotesRepository(db),
    asksRepo: createAsksRepository(db),
    noteConflictsRepo: createNoteConflictsRepository(db),
    syncEventsRepo: createSyncEventsRepository(db),
    syncStateRepo: createSyncStateRepository(db),
    accountId: 'test-account',
    deviceId: 'device-1',
  };
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

describe('resetSyncCursorOnce', () => {
  afterEach(() => {
    for (const db of dbs) db.close();
    dbs.length = 0;
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('旧版で進んでしまったカーソルを0へ戻す', async () => {
    const { syncStateRepo } = makeRepo();
    await syncStateRepo.setCursor(42);

    const result = await resetSyncCursorOnce(syncStateRepo);

    expect(result).toEqual({ reset: true, previousCursor: 42 });
    expect(await syncStateRepo.getCursor()).toBe(0);
  });

  it('2回目以降は何もしない(毎起動でカーソルを戻さない)', async () => {
    const { syncStateRepo } = makeRepo();
    await syncStateRepo.setCursor(42);
    await resetSyncCursorOnce(syncStateRepo);

    // 1回目の後に同期が進んだ状態を作る
    await syncStateRepo.setCursor(7);
    const second = await resetSyncCursorOnce(syncStateRepo);

    expect(second).toEqual({ reset: false, previousCursor: 0 });
    expect(await syncStateRepo.getCursor()).toBe(7); // 進んだ位置がそのまま残る
  });

  it('新規インストール(カーソル0)では戻す対象が無いが、印は付けて次回以降を省く', async () => {
    const { syncStateRepo } = makeRepo();

    const first = await resetSyncCursorOnce(syncStateRepo);
    expect(first).toEqual({ reset: false, previousCursor: 0 });

    // 印が付いているので、その後カーソルが進んでも戻さない
    await syncStateRepo.setCursor(5);
    await resetSyncCursorOnce(syncStateRepo);
    expect(await syncStateRepo.getCursor()).toBe(5);
  });

  it('オールクリア後(印も消える)は再び実行できる', async () => {
    const { syncStateRepo } = makeRepo();
    await resetSyncCursorOnce(syncStateRepo);

    localStorage.clear(); // factoryResetが接頭辞一致で消すのと同じ状態
    await syncStateRepo.setCursor(9);

    const result = await resetSyncCursorOnce(syncStateRepo);
    expect(result).toEqual({ reset: true, previousCursor: 9 });
    expect(await syncStateRepo.getCursor()).toBe(0);
  });

  it('#191の再現と復旧: 旧版が読み飛ばして進めた差分を、移行後に取り込める', async () => {
    const { db, syncStateRepo } = makeRepo();
    const deps = makeDeps(db);

    // 相手端末が暗号化して上げた差分(seq=3)。この端末は同じ鍵を持っている
    const key = (await importDataKey(getOrCreateDataKey(deps.accountId)))!;
    const remoteFile = {
      syncSchemaVersion: 1,
      deviceId: 'device-2',
      writtenAt: 900,
      notes: [
        { termId: 'term-a', body: '相手の本文', diagrams: [], updatedAt: 500, lastEditedBy: 'device-2', noteHistory: [] },
      ],
      asks: [],
      aiTerms: [],
    };
    const blob = {
      seq: 3,
      deviceId: 'device-2',
      payload: await encryptSyncPayload(key, JSON.stringify(remoteFile)),
      createdAt: 1000,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { blobs: [blob], latest: 3 })));

    // 旧版(0.3.0)が読み飛ばした上でカーソルを3まで進めてしまった状態を再現する
    await syncStateRepo.setCursor(3);

    // 更新直後・移行前: since=3で取りに行くため、この差分はもう返ってこない(取りこぼし)
    expect(await deps.notesRepo.getByTermId('term-a')).toBeUndefined();

    // 移行を実行してから同期し直すと、読み直せる
    await resetSyncCursorOnce(deps.syncStateRepo);
    const outcome = await pullFromRelay(deps, 'tok', 'event-migration');

    expect(outcome).toMatchObject({ receivedBlobs: 1, undecryptableBlobs: 0 });
    expect((await deps.notesRepo.getByTermId('term-a'))?.body).toBe('相手の本文');
    expect(await deps.syncStateRepo.getCursor()).toBe(3);
  });
});
