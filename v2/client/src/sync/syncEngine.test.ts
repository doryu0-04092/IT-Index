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
import { decryptSyncPayload, importDataKey, isSyncEnvelope } from './syncCrypto';
import { getOrCreateDataKey } from './syncKeyStore';

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
    accountId: 'test-account',
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

    it('pushToRelayはPOST /api/sync/pushへ自端末deviceIdと暗号化済みpayloadを送る(#182)', async () => {
      const deps = track(makeDeps('device-1'));
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, { seq: 5 }));
      vi.stubGlobal('fetch', fetchMock);

      const result = await pushToRelay(deps, 'tok');

      expect(result).toEqual({ seq: 5 });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('/api/sync/push');
      const body = JSON.parse(init.body);
      // deviceIdは中継の宛先判定に使うため平文のまま(サーバーが自端末ぶんを見分ける必要は
      // 無いが、クライアントが自分の送った分を読み飛ばすのに使う)
      expect(body.deviceId).toBe('device-1');

      // payloadは暗号化されたエンベロープで、平文が現れない
      const envelope = JSON.parse(body.payload);
      expect(isSyncEnvelope(envelope)).toBe(true);
      expect(body.payload).not.toContain('device-1');
      expect(body.payload).not.toContain('syncSchemaVersion');

      // 自分の鍵で復号すると元のスナップショットに戻る
      const key = await importDataKey(getOrCreateDataKey(deps.accountId));
      const decrypted = await decryptSyncPayload(key!, envelope);
      expect(JSON.parse(decrypted!).deviceId).toBe('device-1');
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

    it('PCで取り込んだAI語+ノートが、同期後のAndroidに届く(#169回帰)', async () => {
      const relay = makeRelay();
      vi.stubGlobal('fetch', relay.fetchMock);
      const pc = track(makeDeps('device-pc', false));
      const android = track(makeDeps('device-an', true));

      const record = buildTermRecord({
        term: 'ゼロトラスト',
        readings: ['ゼロトラスト'],
        summary: null,
        field: 'セキュリティ',
        origin: 'ai',
        now: 1000,
      });
      await pc.termsRepo.upsertFromAi(record);
      await pc.notesRepo.applyCommit(record.id, 'AIが起こした説明', [], 'device-pc', 1000);

      await runSync(pc, 'tok');
      const outcome = await runSync(android, 'tok');

      expect(outcome.skippedBlobs).toBe(0);
      expect((await android.termsRepo.getAll()).map((t) => t.term)).toContain('ゼロトラスト');
      expect((await android.notesRepo.getByTermId(record.id))?.body).toBe('AIが起こした説明');
    });

    it('PC解消→PC同期→Android同期の1往復で統一される(1バッチに旧blobと解消blobが混在する実機再現)(#169回帰)', async () => {
      // 修正前の実バグ: 競合相手をfind(=最初に見つかった版=一番古いblob)で選んでいたため、
      // Androidの1回のpullに「解消前のPC blob」と「解消後のblob」が両方入ると古い方を拾い、
      // 「baselineより新しくない=PCの決定ではない」と誤判定して解消結果をバッチごと捨てていた
      const relay = makeRelay();
      vi.stubGlobal('fetch', relay.fetchMock);
      const pc = track(makeDeps('device-pc', false));
      const android = track(makeDeps('device-an', true));

      await pc.notesRepo.saveBody('term-x', 'PC版の内容', 'device-pc', 1000);
      await android.notesRepo.saveBody('term-x', 'Android版の内容', 'device-an', 2000);

      // 実機の操作順: PC同期 → Android同期(競合検出・保持) → PC同期(PCが競合を知る)
      await runSync(pc, 'tok');
      await runSync(android, 'tok');
      await runSync(pc, 'tok');

      // PCで「PC版の内容」を選んで解消 → PC同期(解消結果をpush)
      const conflict = (await pc.noteConflictsRepo.getOpen())[0];
      await pc.notesRepo.applyConflictResolution('term-x', 'PC版の内容', [], 'device-pc', 5000, {
        body: 'Android版の内容',
        diagrams: [],
      });
      await pc.noteConflictsRepo.setResolution(conflict.id, 'local', null, 5000);
      await runSync(pc, 'tok');

      // Android同期1回(pullに解消前blob+解消後blobが同時に入る)で統一されること
      const outcome = await runSync(android, 'tok');
      expect(outcome.adoptedDecisions).toBe(1);
      expect((await android.notesRepo.getByTermId('term-x'))?.body).toBe('PC版の内容');
    });

    // #171: 同期の未検証ケース(失敗経路・ページ跨ぎ・混在バッチ)。
    // 各テストは「実行内容 → 想定結果」を先に定めてから実装している。
    it('B1: pushが413(容量超過)で失敗した場合、同期イベントを作らず例外を投げる', async () => {
      const deps = track(makeDeps('device-1'));
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(jsonResponse(413, { error: { code: 'payload_too_large', message: 'ペイロードが大きすぎます' } })),
      );

      await expect(runSync(deps, 'tok')).rejects.toThrow();

      // pushが通らなかった同期は「始まらなかった」ものとして記録しない
      expect(await deps.syncEventsRepo.getLatest()).toBeUndefined();
    });

    it('B2: pullの2ページ目で失敗した場合、イベントはcompleted:falseで残り1ページ目のcursorは進む', async () => {
      const deps = track(makeDeps('device-1'));
      const fileOf = (body: string, updatedAt: number) => ({
        syncSchemaVersion: 1,
        deviceId: 'device-2',
        writtenAt: updatedAt,
        notes: [{ termId: 'term-a', body, diagrams: [], updatedAt, lastEditedBy: 'device-2', noteHistory: [] }],
        asks: [],
        aiTerms: [],
      });
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/api/sync/push') return Promise.resolve(jsonResponse(201, { seq: 1 }));
        const since = sinceOf(url);
        if (since === 0) {
          return Promise.resolve(
            jsonResponse(200, {
              blobs: [{ seq: 1, deviceId: 'device-2', payload: JSON.stringify(fileOf('1ページ目', 100)), createdAt: 1 }],
              latest: 2,
            }),
          );
        }
        return Promise.reject(new TypeError('Failed to fetch')); // 2ページ目で回線断
      });
      vi.stubGlobal('fetch', fetchMock);

      await expect(runSync(deps, 'tok')).rejects.toThrow();

      const event = await deps.syncEventsRepo.getLatest();
      expect(event?.completed).toBe(false); // 途中失敗の痕跡が残る
      expect(await deps.syncStateRepo.getCursor()).toBe(1); // 1ページ目は原子的に反映済み
      expect((await deps.notesRepo.getByTermId('term-a'))?.body).toBe('1ページ目');
    });

    it('B3: 競合検出と解消blobがページを跨いでも、同一のrunSync内で統一される', async () => {
      const deps = track(makeDeps('device-an', true));
      await deps.notesRepo.saveBody('term-a', 'Android版の内容', 'device-an', 300);
      const pcFile = (body: string, updatedAt: number) => ({
        syncSchemaVersion: 1,
        deviceId: 'device-pc',
        writtenAt: updatedAt,
        notes: [{ termId: 'term-a', body, diagrams: [], updatedAt, lastEditedBy: 'device-pc', noteHistory: [] }],
        asks: [],
        aiTerms: [],
      });
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/api/sync/push') return Promise.resolve(jsonResponse(201, { seq: 1 }));
        const since = sinceOf(url);
        if (since === 0) {
          // 1ページ目: 解消前のPC版 → ここで競合が記録される(baseline=400)
          return Promise.resolve(
            jsonResponse(200, {
              blobs: [{ seq: 1, deviceId: 'device-pc', payload: JSON.stringify(pcFile('PC版(解消前)', 400)), createdAt: 1 }],
              latest: 2,
            }),
          );
        }
        if (since === 1) {
          // 2ページ目: PCの解消結果 → baselineを超えるので決定として採用される
          return Promise.resolve(
            jsonResponse(200, {
              blobs: [{ seq: 2, deviceId: 'device-pc', payload: JSON.stringify(pcFile('PCの解消結果', 900)), createdAt: 2 }],
              latest: 2,
            }),
          );
        }
        return Promise.resolve(jsonResponse(200, { blobs: [], latest: 2 }));
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await runSync(deps, 'tok');

      expect(result.adoptedDecisions).toBe(1);
      expect((await deps.notesRepo.getByTermId('term-a'))?.body).toBe('PCの解消結果');
      expect(await deps.noteConflictsRepo.getOpen()).toHaveLength(0);
    });

    it('B4: 壊れたblobと正常なblobが同じバッチにあっても、正常分だけ取り込む', async () => {
      const deps = track(makeDeps('device-1'));
      const goodFile = {
        syncSchemaVersion: 1,
        deviceId: 'device-2',
        writtenAt: 1,
        notes: [{ termId: 'term-a', body: '正常な本文', diagrams: [], updatedAt: 100, lastEditedBy: 'device-2', noteHistory: [] }],
        asks: [],
        aiTerms: [],
      };
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/api/sync/push') return Promise.resolve(jsonResponse(201, { seq: 1 }));
        return Promise.resolve(
          jsonResponse(200, {
            blobs: [
              { seq: 1, deviceId: 'device-2', payload: '{not json', createdAt: 1 },
              { seq: 2, deviceId: 'device-2', payload: JSON.stringify(goodFile), createdAt: 2 },
            ],
            latest: 2,
          }),
        );
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await runSync(deps, 'tok');

      expect(result.receivedBlobs).toBe(1);
      expect(result.skippedBlobs).toBe(1);
      expect((await deps.notesRepo.getByTermId('term-a'))?.body).toBe('正常な本文');
      expect(await deps.syncStateRepo.getCursor()).toBe(2); // 壊れた分もcursorは進む
    });

    it('B5: 再発時に内容が変わらなければAI統合キャッシュ(merged)を破棄しない', async () => {
      const deps = track(makeDeps('device-1'));
      const relay = makeRelay();
      vi.stubGlobal('fetch', relay.fetchMock);
      relay.blobs.push({ seq: 1, deviceId: 'device-2', payload: JSON.stringify(fileOf('device-2', 'term-a', '相手の内容', 400)), createdAt: 1 });
      await deps.notesRepo.saveBody('term-a', 'この端末の内容', 'device-1', 300);
      await runSync(deps, 'tok');

      // AI統合の結果をキャッシュしてから、未解決へ戻す(選び直しの途中を模す)
      const conflict = (await deps.noteConflictsRepo.getAllOrdered())[0];
      await deps.noteConflictsRepo.setResolution(conflict.id, 'merged', { body: '統合結果', diagrams: [] }, 500);
      await deps.db.noteConflicts.update(conflict.id, { resolution: null, resolvedAt: null });

      // 同じ内容のまま相手が再送 → 競合は再発するが2版の内容は変わっていない
      relay.blobs.push({ seq: 2, deviceId: 'device-2', payload: JSON.stringify(fileOf('device-2', 'term-a', '相手の内容', 400)), createdAt: 2 });
      await runSync(deps, 'tok');

      const after = (await deps.noteConflictsRepo.getAllOrdered())[0];
      expect(after.merged).toEqual({ body: '統合結果', diagrams: [] }); // 再利用できる状態のまま
    });

    it('B5b: 再発時にlocal側だけが変わった場合もAI統合キャッシュを破棄する', async () => {
      // contentChangedはlocal・remoteのどちらかが変われば真。remote据え置きでlocalだけ
      // 書き換えた場合も、以前の2版から作った統合結果は古くなるため破棄されること。
      // 検証はAndroid経路(自版保持)で行う——PC経路(LWW)だと相手の内容が採用されて
      // noteHistoryに入るため、次回は「相手はこちらの過去版を持っているだけ」と判定されて
      // 競合が再発せずsupersededになり、この分岐に到達しない(#171で挙動を確認)。
      const deps = track(makeDeps('device-an', true));
      const relay = makeRelay();
      vi.stubGlobal('fetch', relay.fetchMock);
      relay.blobs.push({ seq: 1, deviceId: 'device-2', payload: JSON.stringify(fileOf('device-2', 'term-a', '相手の内容', 400)), createdAt: 1 });
      await deps.notesRepo.saveBody('term-a', 'この端末の内容', 'device-1', 300);
      await runSync(deps, 'tok');

      const conflict = (await deps.noteConflictsRepo.getAllOrdered())[0];
      await deps.noteConflictsRepo.setResolution(conflict.id, 'merged', { body: '統合結果', diagrams: [] }, 500);
      await deps.db.noteConflicts.update(conflict.id, { resolution: null, resolvedAt: null });

      // この端末側だけを書き換える(相手のblobは同じ内容のまま再送)
      await deps.notesRepo.saveBody('term-a', 'この端末の新しい内容', 'device-1', 600);
      relay.blobs.push({ seq: relay.blobs.length + 1, deviceId: 'device-2', payload: JSON.stringify(fileOf('device-2', 'term-a', '相手の内容', 400)), createdAt: 2 });
      await runSync(deps, 'tok');

      expect((await deps.noteConflictsRepo.getAllOrdered())[0].merged).toBeNull();
    });

    it('B5c: 再発時にremote側だけが変わった場合もAI統合キャッシュを破棄する', async () => {
      // local据え置き・remoteだけ別内容(かつbaseline以下=決定ではない)で再発するケース。
      // Android経路では自版を保持し続けるためlocalは変わらない
      const deps = track(makeDeps('device-an', true));
      const relay = makeRelay();
      vi.stubGlobal('fetch', relay.fetchMock);
      relay.blobs.push({ seq: 1, deviceId: 'device-pc', payload: JSON.stringify(fileOf('device-pc', 'term-a', 'PC版(1)', 400)), createdAt: 1 });
      await deps.notesRepo.saveBody('term-a', 'Android版の内容', 'device-an', 300);
      await runSync(deps, 'tok'); // 競合記録(baseline=400)

      const conflict = (await deps.noteConflictsRepo.getAllOrdered())[0];
      await deps.noteConflictsRepo.setResolution(conflict.id, 'merged', { body: '統合結果', diagrams: [] }, 500);
      await deps.db.noteConflicts.update(conflict.id, { resolution: null, resolvedAt: null });

      // 相手が別内容だが古い時刻の版を送る(baseline以下なので決定にはならない)
      relay.blobs.push({
        seq: relay.blobs.length + 1,
        deviceId: 'device-pc',
        payload: JSON.stringify(fileOf('device-pc', 'term-a', 'PC版(2)', 350)),
        createdAt: 2,
      });
      await runSync(deps, 'tok');

      const after = (await deps.noteConflictsRepo.getAllOrdered())[0];
      expect(after.local.body).toBe('Android版の内容'); // localは据え置き
      expect(after.remote.body).toBe('PC版(2)'); // remoteだけ変わった
      expect(after.merged).toBeNull(); // 古い統合結果は破棄される
    });

    it('B9: 決定を出した端末と競合記録の相手端末が違う場合でも、統一され例外にならない(3端末)', async () => {
      // 競合はdevice-pcとの間で記録されたが、決定として採用されるのはdevice-3の新しい版。
      // 競合行(peerDeviceId=device-pc)は見つからないため自動クローズはされないが、
      // notesは統一され同期は完走する(防御分岐)
      const deps = track(makeDeps('device-an', true));
      const relay = makeRelay();
      vi.stubGlobal('fetch', relay.fetchMock);
      relay.blobs.push({ seq: 1, deviceId: 'device-pc', payload: JSON.stringify(fileOf('device-pc', 'term-a', 'PC版', 400)), createdAt: 1 });
      await deps.notesRepo.saveBody('term-a', 'Android版の内容', 'device-an', 300);
      await runSync(deps, 'tok');
      expect((await deps.noteConflictsRepo.getOpen())[0].peerDeviceId).toBe('device-pc');

      // 別端末(device-3)がbaselineより新しい版を出す
      relay.blobs.push({
        seq: relay.blobs.length + 1,
        deviceId: 'device-3',
        payload: JSON.stringify(fileOf('device-3', 'term-a', '端末3の版', 900)),
        createdAt: 2,
      });
      const outcome = await runSync(deps, 'tok');

      expect(outcome.adoptedDecisions).toBe(1);
      expect((await deps.notesRepo.getByTermId('term-a'))?.body).toBe('端末3の版');
    });

    it('B6: 解消直後の自動push(pushToRelay単発)でも、相手は次のpullで決定を取り込める', async () => {
      const relay = makeRelay();
      vi.stubGlobal('fetch', relay.fetchMock);
      const pc = track(makeDeps('device-pc', false));
      const android = track(makeDeps('device-an', true));

      await pc.notesRepo.saveBody('term-x', 'PC版の内容', 'device-pc', 1000);
      await android.notesRepo.saveBody('term-x', 'Android版の内容', 'device-an', 2000);
      await runSync(pc, 'tok');
      await runSync(android, 'tok');
      await runSync(pc, 'tok');

      // PCで解消 → 「今すぐ同期」ではなく自動push(pushToRelay)だけを行う
      const conflict = (await pc.noteConflictsRepo.getOpen())[0];
      await pc.notesRepo.applyConflictResolution('term-x', 'PC版の内容', [], 'device-pc', 5000, {
        body: 'Android版の内容',
        diagrams: [],
      });
      await pc.noteConflictsRepo.setResolution(conflict.id, 'local', null, 5000);
      await pushToRelay(pc, 'tok');

      const outcome = await runSync(android, 'tok');

      expect(outcome.adoptedDecisions).toBe(1);
      expect((await android.notesRepo.getByTermId('term-x'))?.body).toBe('PC版の内容');
    });

    it('B7: 別peerから新鮮なデータが届き競合が再発しなければsupersededで閉じる(termId単位判定)', async () => {
      const deps = track(makeDeps('device-1'));
      const relay = makeRelay();
      vi.stubGlobal('fetch', relay.fetchMock);
      relay.blobs.push({ seq: 1, deviceId: 'device-2', payload: JSON.stringify(fileOf('device-2', 'term-a', '端末2の内容', 400)), createdAt: 1 });
      await deps.notesRepo.saveBody('term-a', 'この端末の内容', 'device-1', 300);
      await runSync(deps, 'tok');
      expect(await deps.noteConflictsRepo.getOpen()).toHaveLength(1);

      // 別peer(device-3)が、現在この端末が持つ内容と同じものを送ってくる → 競合は再発しない
      relay.blobs.push({
        seq: relay.blobs.length + 1,
        deviceId: 'device-3',
        payload: JSON.stringify(fileOf('device-3', 'term-a', '端末2の内容', 800)),
        createdAt: 3,
      });
      await runSync(deps, 'tok');

      const all = await deps.noteConflictsRepo.getAllOrdered();
      expect(all[0].closedReason).toBe('superseded');
      expect(await deps.noteConflictsRepo.getOpen()).toHaveLength(0);
    });

    it('B8: Androidでopen競合が無い状態の競合はbaselineが無く、自版を保持して競合として記録し直す', async () => {
      // 当初「LWWで新しい方が採用される」と想定したが、実際はholdLocalOnConflict時に
      // baselineが無い競合は必ず自版保持になる(mergeSnapshot:116-123)。これが正しい:
      // baselineが無い=「PC側の決定と確認できない」ため、勝手に相手版で上書きしない。
      // 決着は改めて記録された競合をPCが解消して伝えることで付く(#171で挙動を確認・固定)。
      const deps = track(makeDeps('device-an', true));
      await deps.notesRepo.saveBody('term-a', 'Android版の内容', 'device-an', 300);
      const relay = makeRelay();
      vi.stubGlobal('fetch', relay.fetchMock);
      relay.blobs.push({
        seq: 1,
        deviceId: 'device-pc',
        payload: JSON.stringify(fileOf('device-pc', 'term-a', 'PC版(解消前)', 400)),
        createdAt: 1,
      });
      await runSync(deps, 'tok'); // 競合を記録(baseline=400)

      // 競合行だけを解決済みにする(open競合=baselineが無い状態を作る)
      const conflict = (await deps.noteConflictsRepo.getOpen())[0];
      await deps.noteConflictsRepo.setResolution(conflict.id, 'local', null, 500);

      relay.blobs.push({
        seq: relay.blobs.length + 1,
        deviceId: 'device-pc',
        payload: JSON.stringify(fileOf('device-pc', 'term-a', 'PCの解消結果', 900)),
        createdAt: 2,
      });
      const outcome = await runSync(deps, 'tok');

      expect(outcome.receivedBlobs).toBeGreaterThan(0);
      // 自版を保持し、決定として採用はしない(勝手な上書きをしない)
      expect(outcome.adoptedDecisions).toBe(0);
      expect((await deps.notesRepo.getByTermId('term-a'))?.body).toBe('Android版の内容');
      // 新しい競合として記録され直し、次にPCが解消すれば統一できる状態になる
      const open = await deps.noteConflictsRepo.getOpen();
      expect(open).toHaveLength(1);
      expect(open[0].remote.body).toBe('PCの解消結果');
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
