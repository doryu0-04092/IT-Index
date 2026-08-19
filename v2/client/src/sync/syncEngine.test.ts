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
import { buildOutboundPayload, pullFromRelay, pushToRelay, runSync, type SyncEngineDeps } from './syncEngine';

function makeDeps(deviceId = 'device-1', holdLocalOnConflict = false): SyncEngineDeps {
  const db = new ItIndexDB(`test-syncEngine-${Math.random()}`);
  return {
    db,
    termsRepo: createTermsRepository(db),
    notesRepo: createNotesRepository(db),
    asksRepo: createAsksRepository(db),
    noteConflictsRepo: createNoteConflictsRepository(db),
    syncEventsRepo: createSyncEventsRepository(db),
    syncStateRepo: createSyncStateRepository(db),
    deviceId,
    holdLocalOnConflict,
  };
}

/** pullFromRelay単体テスト用の同期イベントID(runSyncを経ないテストで使う) */
const EVENT = 'event-test';

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

      const outcome = await pullFromRelay(deps, 'tok', EVENT);

      expect(outcome).toMatchObject({ receivedBlobs: 1, skippedBlobs: 0, conflicts: 0 });
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

      const outcome = await pullFromRelay(deps, 'tok', EVENT);

      expect(outcome).toMatchObject({ receivedBlobs: 0, skippedBlobs: 0, conflicts: 0 });
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

      const outcome = await pullFromRelay(deps, 'tok', EVENT);

      expect(outcome).toMatchObject({ receivedBlobs: 0, skippedBlobs: 1, conflicts: 0 });
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

      const outcome = await pullFromRelay(deps, 'tok', EVENT);
      expect(outcome).toMatchObject({ receivedBlobs: 0, skippedBlobs: 1, conflicts: 0 });
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

      const outcome = await pullFromRelay(deps, 'tok', EVENT);

      expect(outcome.conflicts).toBe(1);
      const unresolved = await deps.noteConflictsRepo.getOpen();
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

      const outcome = await pullFromRelay(deps, 'tok', EVENT);

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

      await expect(pullFromRelay(deps, 'tok', EVENT)).rejects.toThrow(boom);

      // notesの書き込みが先に走っていても、同じトランザクション内なのでロールバックされている
      expect(await deps.notesRepo.getByTermId('term-a')).toBeUndefined();
      expect(await deps.syncStateRepo.getCursor()).toBe(0); // 進んでいない
    });
  });

  /**
   * #157: 競合解消のPC集中化と同期イベントのリンク。
   * makeRelay()はサーバー(/api/sync/push・pull)のインメモリ模型で、
   * 2端末結合シナリオでは同じrelayを両端末のdepsが共有する。
   */
  describe('#157 競合のPC集中化と同期イベント', () => {
    function makeRelay() {
      const blobs: { seq: number; deviceId: string; payload: string; createdAt: number }[] = [];
      const fetchMock = vi.fn().mockImplementation((url: string, init?: { body?: string }) => {
        if (url === '/api/sync/push') {
          const body = JSON.parse(String(init?.body));
          const seq = blobs.length + 1;
          blobs.push({ seq, deviceId: body.deviceId, payload: body.payload, createdAt: seq });
          return Promise.resolve(jsonResponse(201, { seq }));
        }
        const since = sinceOf(url);
        return Promise.resolve(jsonResponse(200, { blobs: blobs.filter((b) => b.seq > since), latest: blobs.length }));
      });
      return { blobs, fetchMock };
    }

    function fileOf(deviceId: string, termId: string, body: string, updatedAt: number, lastEditedBy = deviceId) {
      return {
        syncSchemaVersion: 1,
        deviceId,
        writtenAt: updatedAt,
        notes: [{ termId, body, diagrams: [], updatedAt, lastEditedBy, noteHistory: [] }],
        asks: [],
        aiTerms: [],
      };
    }

    it('runSyncは同期イベントを記録し、競合をそのイベントへリンクする', async () => {
      const deps = track(makeDeps('device-1'));
      const relay = makeRelay();
      vi.stubGlobal('fetch', relay.fetchMock);
      relay.blobs.push({ seq: 1, deviceId: 'device-2', payload: JSON.stringify(fileOf('device-2', 'term-a', '相手の内容', 400)), createdAt: 1 });
      await deps.notesRepo.saveBody('term-a', 'この端末の内容', 'device-1', 300);

      const result = await runSync(deps, 'tok');

      expect(result.conflictCount).toBe(1);
      const event = await deps.syncEventsRepo.getLatest();
      expect(event).toMatchObject({ id: result.syncEventId, receivedBlobs: 1, conflictCount: 1, completed: true });
      expect(event?.peerDeviceIds).toEqual(['device-2']);
      const linked = await deps.noteConflictsRepo.getBySyncEventId(result.syncEventId);
      expect(linked).toHaveLength(1);
      expect(linked[0].termId).toBe('term-a');
    });

    it('再発した競合は重複addせず同じopen行を更新する(古いAI統合キャッシュは内容が変われば破棄)', async () => {
      const deps = track(makeDeps('device-1'));
      const relay = makeRelay();
      vi.stubGlobal('fetch', relay.fetchMock);
      relay.blobs.push({ seq: 1, deviceId: 'device-2', payload: JSON.stringify(fileOf('device-2', 'term-a', '相手の内容v1', 400)), createdAt: 1 });
      await deps.notesRepo.saveBody('term-a', 'この端末の内容', 'device-1', 300);

      const first = await runSync(deps, 'tok');
      // 1回目の同期でLWWにより相手版が採用されたので、この端末で再度独自編集して競合条件を作り直す
      await deps.notesRepo.saveBody('term-a', 'この端末の内容v2', 'device-1', 500);
      relay.blobs.push({ seq: relay.blobs.length + 1, deviceId: 'device-2', payload: JSON.stringify(fileOf('device-2', 'term-a', '相手の内容v2', 600)), createdAt: 2 });
      const second = await runSync(deps, 'tok');

      const all = await deps.noteConflictsRepo.getAllOrdered();
      expect(all).toHaveLength(1); // 重複addされていない
      expect(all[0].syncEventId).toBe(second.syncEventId);
      expect(all[0].syncEventId).not.toBe(first.syncEventId);
      expect(all[0].remote.body).toBe('相手の内容v2'); // スナップショットが更新されている
    });

    it('新鮮なデータで競合が再発しなければsupersededで閉じ、直近イベントのリストから消える', async () => {
      const deps = track(makeDeps('device-1'));
      const relay = makeRelay();
      vi.stubGlobal('fetch', relay.fetchMock);
      relay.blobs.push({ seq: 1, deviceId: 'device-2', payload: JSON.stringify(fileOf('device-2', 'term-a', '相手の内容', 400)), createdAt: 1 });
      await deps.notesRepo.saveBody('term-a', 'この端末の内容', 'device-1', 300);
      await runSync(deps, 'tok');

      // 相手が同じ内容(=現在この端末が持つLWW採用済みの内容)を改めて送ってきた → 競合は再発しない
      relay.blobs.push({ seq: relay.blobs.length + 1, deviceId: 'device-2', payload: JSON.stringify(fileOf('device-2', 'term-a', '相手の内容', 700)), createdAt: 2 });
      const second = await runSync(deps, 'tok');

      const all = await deps.noteConflictsRepo.getAllOrdered();
      expect(all[0].closedReason).toBe('superseded');
      expect(await deps.noteConflictsRepo.getBySyncEventId(second.syncEventId)).toHaveLength(0);
      expect(await deps.noteConflictsRepo.getOpen()).toHaveLength(0);
    });

    it('新データ未着のopen競合は最新イベントへ持ち越す(リストから消えない)', async () => {
      const deps = track(makeDeps('device-1'));
      const relay = makeRelay();
      vi.stubGlobal('fetch', relay.fetchMock);
      relay.blobs.push({ seq: 1, deviceId: 'device-2', payload: JSON.stringify(fileOf('device-2', 'term-a', '相手の内容', 400)), createdAt: 1 });
      await deps.notesRepo.saveBody('term-a', 'この端末の内容', 'device-1', 300);
      await runSync(deps, 'tok');

      // 相手は何も送ってこない(pushで自分のblobが増えるだけ)
      const second = await runSync(deps, 'tok');

      const linked = await deps.noteConflictsRepo.getBySyncEventId(second.syncEventId);
      expect(linked).toHaveLength(1);
      expect(linked[0].closedReason).toBeNull();
      expect(second.conflictCount).toBe(1);
    });

    it('holdLocalOnConflict(Androidネイティブ): 競合時に自分の版を保持しLWWで上書きしない', async () => {
      const deps = track(makeDeps('device-an', true));
      const relay = makeRelay();
      vi.stubGlobal('fetch', relay.fetchMock);
      relay.blobs.push({ seq: 1, deviceId: 'device-pc', payload: JSON.stringify(fileOf('device-pc', 'term-a', 'PC側の内容', 400)), createdAt: 1 });
      await deps.notesRepo.saveBody('term-a', 'Android側の内容', 'device-an', 300);

      const result = await runSync(deps, 'tok');

      // 相手の方が新しくても、自分の版のまま(パソコン側の決定が来るまで保持)
      expect((await deps.notesRepo.getByTermId('term-a'))?.body).toBe('Android側の内容');
      expect(result.conflictCount).toBe(1);
      expect(result.adoptedDecisions).toBe(0);
    });

    it('2端末結合: PCで解消→Androidが決定を採用して統一→PC側も競合ゼロ(デッドロック回帰)', async () => {
      const relay = makeRelay();
      vi.stubGlobal('fetch', relay.fetchMock);
      const pc = track(makeDeps('device-pc', false));
      const android = track(makeDeps('device-an', true));

      // 両端末が同じ語を独自に編集(Androidの方が新しい)
      await pc.notesRepo.saveBody('term-a', 'PC版の内容', 'device-pc', 1000);
      await android.notesRepo.saveBody('term-a', 'Android版の内容', 'device-an', 2000);

      await runSync(android, 'tok'); // Androidがpush(相手のデータはまだ無い)
      await runSync(pc, 'tok'); // PC: Android版との競合を検出(LWWでAndroid版を先に採用)
      await runSync(android, 'tok'); // Android: PC版(古い)との競合を検出、自分の版を保持

      const pcConflicts = await pc.noteConflictsRepo.getOpen();
      expect(pcConflicts).toHaveLength(1);
      const androidOpen = await android.noteConflictsRepo.getOpen();
      expect(androidOpen).toHaveLength(1);
      expect((await android.notesRepo.getByTermId('term-a'))?.body).toBe('Android版の内容');

      // PCで「この端末(PC)の内容」を選んで解消(updatedAtは競合検出時より新しい時刻)
      const conflict = pcConflicts[0];
      await pc.notesRepo.applyConflictResolution(
        'term-a',
        conflict.local.body,
        conflict.local.diagrams,
        'device-pc',
        3000,
        { body: conflict.remote.body, diagrams: conflict.remote.diagrams },
      );
      await pc.noteConflictsRepo.setResolution(conflict.id, 'local', null, 3000);

      await runSync(pc, 'tok'); // PCが解消結果をpush
      const androidSecond = await runSync(android, 'tok'); // Androidが決定を採用

      expect(androidSecond.adoptedDecisions).toBe(1);
      expect((await android.notesRepo.getByTermId('term-a'))?.body).toBe('PC版の内容');
      expect((await android.notesRepo.getByTermId('term-a'))?.lastEditedBy).toBe('device-pc'); // 書き換えない
      const androidClosed = (await android.noteConflictsRepo.getAllOrdered())[0];
      expect(androidClosed.closedReason).toBe('peer-decision');
      expect(await android.noteConflictsRepo.getOpen()).toHaveLength(0);

      // さらに一往復しても、どちらの端末でも競合は増えない(デッドロックしない)
      await runSync(android, 'tok');
      await runSync(pc, 'tok');
      expect(await pc.noteConflictsRepo.getOpen()).toHaveLength(0);
      expect(await android.noteConflictsRepo.getOpen()).toHaveLength(0);
      expect((await pc.notesRepo.getByTermId('term-a'))?.body).toBe('PC版の内容');
      expect((await android.notesRepo.getByTermId('term-a'))?.body).toBe('PC版の内容');
    });
  });
});
