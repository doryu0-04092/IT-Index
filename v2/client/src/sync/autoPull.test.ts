import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ItIndexDB } from '../db';
import { createAsksRepository } from '../repositories/asks';
import { createNoteConflictsRepository } from '../repositories/noteConflicts';
import { createNotesRepository } from '../repositories/notes';
import { createSyncEventsRepository } from '../repositories/syncEvents';
import { createSyncStateRepository } from '../repositories/syncState';
import { createTermsRepository } from '../repositories/terms';
import { runAutoPull, shouldRefreshAfterAutoPull, type AutoPullOutcome } from './autoPull';
import type { SyncEngineDeps, SyncRunResult } from './syncEngine';

const dbs: ItIndexDB[] = [];

function makeSyncDeps(): SyncEngineDeps {
  const db = new ItIndexDB(`test-autoPull-${Math.random()}`);
  dbs.push(db);
  return {
    db,
    termsRepo: createTermsRepository(db),
    notesRepo: createNotesRepository(db),
    asksRepo: createAsksRepository(db),
    noteConflictsRepo: createNoteConflictsRepository(db),
    syncEventsRepo: createSyncEventsRepository(db),
    syncStateRepo: createSyncStateRepository(db),
    accountId: 'acc-1',
    deviceId: 'device-1',
    holdLocalOnConflict: false,
  };
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

function runResult(overrides: Partial<SyncRunResult> = {}): SyncRunResult {
  return {
    syncEventId: 'e1',
    receivedBlobs: 0,
    skippedBlobs: 0,
    undecryptableBlobs: 0,
    conflictCount: 0,
    adoptedDecisions: 0,
    ...overrides,
  };
}

describe('runAutoPull', () => {
  afterEach(() => {
    for (const db of dbs) db.close();
    dbs.length = 0;
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('オフラインなら何もしない(APIを呼ばない)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await runAutoPull({ token: 'tok', syncDeps: makeSyncDeps(), online: false });

    expect(outcome).toEqual({ status: 'skipped', reason: 'offline' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('未ログインなら何もしない(APIを呼ばない)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await runAutoPull({ token: null, syncDeps: makeSyncDeps(), online: true });

    expect(outcome).toEqual({ status: 'skipped', reason: 'not-authed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('deviceId・accountIdが未確定なら何もしない', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await runAutoPull({ token: 'tok', syncDeps: null, online: true });

    expect(outcome).toEqual({ status: 'skipped', reason: 'not-ready' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('条件が揃えば同期を実行する', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve(
          url.includes('/api/sync/push')
            ? jsonResponse(201, { seq: 1 })
            : jsonResponse(200, { blobs: [], latest: 0 }),
        ),
      ),
    );

    const outcome = await runAutoPull({ token: 'tok', syncDeps: makeSyncDeps(), online: true });

    expect(outcome.status).toBe('succeeded');
  });

  it('未ライセンス(403)は失敗として区別するが、例外は投げない', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(403, { error: { code: 'license_required', message: 'ライセンスが必要です' } }),
      ),
    );

    const outcome = await runAutoPull({ token: 'tok', syncDeps: makeSyncDeps(), online: true });

    expect(outcome).toEqual({ status: 'failed', reason: 'unlicensed' });
  });

  it('通信失敗でも例外を投げない(起動のたびにエラーを出さない)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const outcome = await runAutoPull({ token: 'tok', syncDeps: makeSyncDeps(), online: true });

    expect(outcome).toEqual({ status: 'failed', reason: 'other' });
  });
});

describe('shouldRefreshAfterAutoPull', () => {
  it('受信があれば画面を読み直す', () => {
    const outcome: AutoPullOutcome = { status: 'succeeded', result: runResult({ receivedBlobs: 2 }) };
    expect(shouldRefreshAfterAutoPull(outcome)).toBe(true);
  });

  it('相手側の決定を採用した場合も読み直す', () => {
    const outcome: AutoPullOutcome = {
      status: 'succeeded',
      result: runResult({ adoptedDecisions: 1 }),
    };
    expect(shouldRefreshAfterAutoPull(outcome)).toBe(true);
  });

  it('受信0件・統一0件なら読み直さない(無駄な再描画を避ける)', () => {
    const outcome: AutoPullOutcome = { status: 'succeeded', result: runResult() };
    expect(shouldRefreshAfterAutoPull(outcome)).toBe(false);
  });

  it('スキップ・失敗では読み直さない', () => {
    expect(shouldRefreshAfterAutoPull({ status: 'skipped', reason: 'offline' })).toBe(false);
    expect(shouldRefreshAfterAutoPull({ status: 'failed', reason: 'unlicensed' })).toBe(false);
  });
});
