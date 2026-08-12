import 'fake-indexeddb/auto';
import { buildTermRecord } from '@it-index/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ItIndexDB } from '../db';
import { createAsksRepository } from '../repositories/asks';
import { createNoteConflictsRepository } from '../repositories/noteConflicts';
import { createNotesRepository } from '../repositories/notes';
import { createSyncStateRepository } from '../repositories/syncState';
import { createTermsRepository } from '../repositories/terms';
import { buildOutboundPayload, pullFromRelay, pushToRelay, type SyncEngineDeps } from './syncEngine';

function makeDeps(deviceId = 'device-1'): SyncEngineDeps {
  const db = new ItIndexDB(`test-syncEngine-${Math.random()}`);
  return {
    db,
    termsRepo: createTermsRepository(db),
    notesRepo: createNotesRepository(db),
    asksRepo: createAsksRepository(db),
    noteConflictsRepo: createNoteConflictsRepository(db),
    syncStateRepo: createSyncStateRepository(db),
    deviceId,
  };
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

/** GET /api/sync/pull?since=N のURLからNを取り出す */
function sinceOf(url: string): number {
  return Number(new URL(url, 'http://localhost').searchParams.get('since'));
}

describe('syncEngine', () => {
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

  describe('buildOutboundPayload / pushToRelay', () => {
    it('notesはnoteHistoryを空にし、termsはisSyncTarget(origin:aiまたはtombstone)のみ、asksは全件になる', async () => {
      const deps = track(makeDeps());
      await deps.notesRepo.saveBody('term-a', '本文', deps.deviceId, 100);
      await deps.notesRepo.saveBody('term-a', '本文2', deps.deviceId, 200); // noteHistoryに1件積む
      await deps.asksRepo.addSearchConfirm('term-a', deps.deviceId, 100);
      await deps.termsRepo.bulkPutFromSeed([
        buildTermRecord({ term: 'シード語', readings: ['シード'], summary: 'x', field: '基礎理論', origin: 'seed', now: 1 }),
      ]);
      await deps.termsRepo.bulkPutFromSeed([
        buildTermRecord({ term: 'AI語', readings: ['エーアイ'], summary: null, field: 'AI', origin: 'ai', now: 1 }),
      ]);

      const payload = JSON.parse(await buildOutboundPayload(deps));

      expect(payload.syncSchemaVersion).toBe(1);
      expect(payload.deviceId).toBe(deps.deviceId);
      expect(payload.notes).toHaveLength(1);
      expect(payload.notes[0].noteHistory).toEqual([]); // 送信時は履歴を落とす
      expect(payload.asks).toHaveLength(1);
      // origin:'seed'(非削除)は送らない。origin:'ai'のみ送る
      expect(payload.aiTerms).toHaveLength(1);
      expect(payload.aiTerms[0].origin).toBe('ai');
    });

    it('pushToRelayはPOST /api/sync/pushへ自端末deviceIdとpayloadを送る', async () => {
      const deps = track(makeDeps('device-1'));
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, { seq: 5 }));
      vi.stubGlobal('fetch', fetchMock);

      const result = await pushToRelay(deps, 'tok');

      expect(result).toEqual({ seq: 5 });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('/api/sync/push');
      const body = JSON.parse(init.body);
      expect(body.deviceId).toBe('device-1');
      expect(JSON.parse(body.payload).deviceId).toBe('device-1');
    });
  });

  describe('pullFromRelay', () => {
    it('自端末以外のblobを検証・決定的マージし、cursorをlatestまで進める', async () => {
      const deps = track(makeDeps('device-1'));
      const remoteFile = {
        syncSchemaVersion: 1,
        deviceId: 'device-2',
        writtenAt: 900,
        notes: [{ termId: 'term-a', body: '相手の本文', diagrams: [], updatedAt: 500, lastEditedBy: 'device-2', noteHistory: [] }],
        asks: [{ id: 'ask-1', termId: 'term-a', sessionId: null, at: 500, deviceId: 'device-2', source: 'search' }],
        aiTerms: [],
      };
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          jsonResponse(200, {
            blobs: [{ seq: 3, deviceId: 'device-2', payload: JSON.stringify(remoteFile), createdAt: 1000 }],
            latest: 3,
          }),
        ),
      );

      const outcome = await pullFromRelay(deps, 'tok');

      expect(outcome).toEqual({ receivedBlobs: 1, skippedBlobs: 0, conflicts: 0 });
      expect((await deps.notesRepo.getByTermId('term-a'))?.body).toBe('相手の本文');
      expect(await deps.syncStateRepo.getCursor()).toBe(3);
    });

    it('自端末が送ったblob自体は取り込み対象から除外する(スキップ扱いにもしない)', async () => {
      const deps = track(makeDeps('device-1'));
      const ownFile = { syncSchemaVersion: 1, deviceId: 'device-1', writtenAt: 1, notes: [], asks: [], aiTerms: [] };
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          jsonResponse(200, { blobs: [{ seq: 1, deviceId: 'device-1', payload: JSON.stringify(ownFile), createdAt: 1 }], latest: 1 }),
        ),
      );

      const outcome = await pullFromRelay(deps, 'tok');

      expect(outcome).toEqual({ receivedBlobs: 0, skippedBlobs: 0, conflicts: 0 });
      expect(await deps.syncStateRepo.getCursor()).toBe(1); // カーソルは進む
    });

    it('検証に通らないblobはスキップして既存データを保持し、カーソルは進める', async () => {
      const deps = track(makeDeps('device-1'));
      await deps.notesRepo.saveBody('term-a', '既存の本文', 'device-1', 100);

      const brokenFile = { syncSchemaVersion: 999, deviceId: 'device-2', notes: [], asks: [], aiTerms: [] }; // 未知のスキーマ版
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          jsonResponse(200, { blobs: [{ seq: 1, deviceId: 'device-2', payload: JSON.stringify(brokenFile), createdAt: 1 }], latest: 1 }),
        ),
      );

      const outcome = await pullFromRelay(deps, 'tok');

      expect(outcome).toEqual({ receivedBlobs: 0, skippedBlobs: 1, conflicts: 0 });
      expect((await deps.notesRepo.getByTermId('term-a'))?.body).toBe('既存の本文'); // 保持されている
      expect(await deps.syncStateRepo.getCursor()).toBe(1); // 同じ壊れたblobを繰り返し取得しないため進む
    });

    it('JSON構文エラーのblobもスキップ扱いになる', async () => {
      const deps = track(makeDeps('device-1'));
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          jsonResponse(200, { blobs: [{ seq: 1, deviceId: 'device-2', payload: '{not json', createdAt: 1 }], latest: 1 }),
        ),
      );

      const outcome = await pullFromRelay(deps, 'tok');
      expect(outcome).toEqual({ receivedBlobs: 0, skippedBlobs: 1, conflicts: 0 });
    });

    it('両端末が独自に編集していた場合はnoteConflictsに記録する', async () => {
      const deps = track(makeDeps('device-1'));
      await deps.notesRepo.saveBody('term-a', 'この端末の内容', 'device-1', 300);

      const remoteFile = {
        syncSchemaVersion: 1,
        deviceId: 'device-2',
        writtenAt: 1,
        notes: [{ termId: 'term-a', body: '相手の内容', diagrams: [], updatedAt: 400, lastEditedBy: 'device-2', noteHistory: [] }],
        asks: [],
        aiTerms: [],
      };
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          jsonResponse(200, { blobs: [{ seq: 1, deviceId: 'device-2', payload: JSON.stringify(remoteFile), createdAt: 1 }], latest: 1 }),
        ),
      );

      const outcome = await pullFromRelay(deps, 'tok');

      expect(outcome.conflicts).toBe(1);
      const unresolved = await deps.noteConflictsRepo.getUnresolved();
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0].local.body).toBe('この端末の内容');
      expect(unresolved[0].remote.body).toBe('相手の内容');
      // updatedAtが新しい方(相手)がnewest-winsで採用されている
      expect((await deps.notesRepo.getByTermId('term-a'))?.body).toBe('相手の内容');
    });

    it('ページ上限で複数回に分かれて返る場合、latestに達するまでpullを繰り返す', async () => {
      const deps = track(makeDeps('device-1'));
      const fileOf = (deviceId: string, termId: string, body: string, updatedAt: number) => ({
        syncSchemaVersion: 1,
        deviceId,
        writtenAt: updatedAt,
        notes: [{ termId, body, diagrams: [], updatedAt, lastEditedBy: deviceId, noteHistory: [] }],
        asks: [],
        aiTerms: [],
      });

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        const since = sinceOf(url);
        if (since === 0) {
          return Promise.resolve(
            jsonResponse(200, {
              blobs: [{ seq: 1, deviceId: 'device-2', payload: JSON.stringify(fileOf('device-2', 'term-a', 'ページ1', 100)), createdAt: 1 }],
              latest: 2,
            }),
          );
        }
        if (since === 1) {
          return Promise.resolve(
            jsonResponse(200, {
              blobs: [{ seq: 2, deviceId: 'device-2', payload: JSON.stringify(fileOf('device-2', 'term-b', 'ページ2', 200)), createdAt: 2 }],
              latest: 2,
            }),
          );
        }
        return Promise.resolve(jsonResponse(200, { blobs: [], latest: 2 }));
      });
      vi.stubGlobal('fetch', fetchMock);

      const outcome = await pullFromRelay(deps, 'tok');

      expect(outcome.receivedBlobs).toBe(2);
      expect(await deps.syncStateRepo.getCursor()).toBe(2);
      expect((await deps.notesRepo.getByTermId('term-a'))?.body).toBe('ページ1');
      expect((await deps.notesRepo.getByTermId('term-b'))?.body).toBe('ページ2');
      // since=0 → 1 の2回で、2回目でcursor(2)がlatest(2)に達するため3回目は呼ばれない
      expect(fetchMock.mock.calls.map((call: unknown[]) => sinceOf(call[0] as string))).toEqual([0, 1]);
    });

    it('取り込み中に例外が起きた場合、ロールバックしcursorを進めない(原子性)', async () => {
      const deps = track(makeDeps('device-1'));
      const remoteFile = {
        syncSchemaVersion: 1,
        deviceId: 'device-2',
        writtenAt: 1,
        notes: [{ termId: 'term-a', body: '相手の本文', diagrams: [], updatedAt: 100, lastEditedBy: 'device-2', noteHistory: [] }],
        asks: [],
        aiTerms: [],
      };
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          jsonResponse(200, { blobs: [{ seq: 9, deviceId: 'device-2', payload: JSON.stringify(remoteFile), createdAt: 1 }], latest: 9 }),
        ),
      );

      const boom = new Error('書き込み失敗(テスト用)');
      vi.spyOn(deps.asksRepo, 'upsertFromSync').mockRejectedValue(boom);

      await expect(pullFromRelay(deps, 'tok')).rejects.toThrow(boom);

      // notesの書き込みが先に走っていても、同じトランザクション内なのでロールバックされている
      expect(await deps.notesRepo.getByTermId('term-a')).toBeUndefined();
      expect(await deps.syncStateRepo.getCursor()).toBe(0); // 進んでいない
    });
  });
});
