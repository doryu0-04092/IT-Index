import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ItIndexDB } from '../client/src/db';
import { createAsksRepository } from '../client/src/repositories/asks';
import { createNoteConflictsRepository } from '../client/src/repositories/noteConflicts';
import { createNotesRepository } from '../client/src/repositories/notes';
import { createSyncEventsRepository } from '../client/src/repositories/syncEvents';
import { createSyncStateRepository } from '../client/src/repositories/syncState';
import { createTermsRepository } from '../client/src/repositories/terms';
import { setServerBaseUrl } from '../client/src/sync/serverConfig';
import { generateDataKey } from '../client/src/sync/syncCrypto';
import { runSync, SyncKeyMissingError, type SyncEngineDeps } from '../client/src/sync/syncEngine';
import { clearDataKey, setDataKey } from '../client/src/sync/syncKeyStore';

/**
 * 同期の結合テスト(#230)。**クライアントの同期エンジンを、実サーバー相手に複数端末で回す。**
 *
 * これまでは「クライアントはサーバーの模型を、サーバーはクライアントの模型を」相手に
 * テストしていて、両者を繋いだ検証が1つも無かった。しかも模型は実サーバーとずれていた
 * (`latest` が模型では `blobs.length`、実サーバーは `MAX(seq)`。#202の圧縮が模型に無い)。
 *
 * **アプリ側のコードは一切変えずに実サーバーへ向けている。** `apiClient` の基底URLは
 * `getServerBaseUrl() ?? VITE_API_BASE ?? ''` の順なので、`setServerBaseUrl` で
 * 実サーバーのURLを入れれば実物を叩く。`globalThis.fetch` を Worker のエントリポイントへ
 * 差し替えることで、その通信が実際の Worker + 実D1 へ届く。
 */

const BASE = 'https://example.com';
const PASSWORD = 'TestPass2026';

/** シナリオの経過を人が読める形で残す。落ちた時に「何が起きたか」を追うための記録 */
const timeline: string[] = [];
function step(text: string) {
  timeline.push(text);
}

interface Device {
  name: string;
  db: ItIndexDB;
  deps: SyncEngineDeps;
}

function makeDevice(name: string, accountId: string): Device {
  const db = new ItIndexDB(`integration-${name}-${crypto.randomUUID()}`);
  return {
    name,
    db,
    deps: {
      db,
      termsRepo: createTermsRepository(db),
      notesRepo: createNotesRepository(db),
      asksRepo: createAsksRepository(db),
      noteConflictsRepo: createNoteConflictsRepository(db),
      syncEventsRepo: createSyncEventsRepository(db),
      syncStateRepo: createSyncStateRepository(db),
      accountId,
      deviceId: `device-${name}`,
    },
  };
}

/** 端末の現在の状態を1行で表す(記録用) */
async function describeDevice(d: Device, termId: string): Promise<string> {
  const note = await d.deps.notesRepo.getByTermId(termId);
  const open = await d.deps.noteConflictsRepo.getOpen();
  const all = await d.deps.noteConflictsRepo.getAllOrdered();
  const closed = all.filter((c) => c.closedReason !== null);
  const peers = open
    .map((c) => c.peerDeviceId.replace('device-', ''))
    .sort()
    .join(',');
  const closedText = closed
    .map((c) => `${c.peerDeviceId.replace('device-', '')}:${c.closedReason}`)
    .sort()
    .join(',');
  const cursor = await d.deps.syncStateRepo.getCursor();
  const openText = peers === '' ? '' : `(${peers})`;
  const closedSuffix = closedText === '' ? '' : `(${closedText})`;
  return `端末${d.name}: ノート="${note?.body ?? '(無し)'}" 未解決=${open.length}${openText} 決着=${closed.length}${closedSuffix} カーソル=${cursor}`;
}

async function signup(): Promise<{ token: string; accountId: string }> {
  const email = `sync-int-${crypto.randomUUID()}@example.com`;
  const res = await exports.default.fetch(`${BASE}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(res.status).toBe(201);
  const body = await res.json<{ token: string }>();
  const row = await env.DB.prepare('SELECT id FROM accounts WHERE email = ?1')
    .bind(email.toLowerCase())
    .first<{ id: string }>();
  if (row === null) throw new Error('作成したアカウントが引けない');
  return { token: body.token, accountId: row.id };
}

/** その端末のblobがサーバーに何行あるか(#202の圧縮の確認に使う) */
async function blobRowCount(accountId: string, deviceId?: string): Promise<number> {
  const stmt =
    deviceId === undefined
      ? env.DB.prepare('SELECT COUNT(*) AS n FROM sync_blobs WHERE account_id = ?1').bind(accountId)
      : env.DB.prepare(
          'SELECT COUNT(*) AS n FROM sync_blobs WHERE account_id = ?1 AND device_id = ?2',
        ).bind(accountId, deviceId);
  const row = await stmt.first<{ n: number }>();
  return row?.n ?? 0;
}

let originalFetch: typeof globalThis.fetch;
const openDbs: ItIndexDB[] = [];

function track(d: Device): Device {
  openDbs.push(d.db);
  return d;
}

beforeEach(() => {
  timeline.length = 0;
  originalFetch = globalThis.fetch;
  // クライアントの通信を実Workerへ届ける(ここだけがテスト用の配線)
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    exports.default.fetch(String(input), init)) as typeof fetch;
  setServerBaseUrl(BASE);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const db of openDbs) db.close();
  openDbs.length = 0;
  localStorage.clear();
  // シナリオの経過を出力する(#230の本人指定: pass/failだけでなく何が起きたかを残す)
  if (timeline.length > 0) console.log('\n' + timeline.map((t) => `  ${t}`).join('\n'));
});

describe('同期の結合テスト(実サーバー × 複数端末)', () => {
  it('2端末: 片方で書いたノートが、実サーバー経由でもう片方へ届く', async () => {
    const account = await signup();
    setDataKey(account.accountId, generateDataKey()); // 鍵の受け渡しが済んだ状態
    const a = track(makeDevice('A', account.accountId));
    const b = track(makeDevice('B', account.accountId));

    await a.deps.notesRepo.saveBody('tcp-ip', 'Aが書いた本文', a.deps.deviceId, 300);
    await runSync(a.deps, account.token);
    step(await describeDevice(a, 'tcp-ip'));

    const result = await runSync(b.deps, account.token);
    step(await describeDevice(b, 'tcp-ip'));

    const noteOnB = await b.deps.notesRepo.getByTermId('tcp-ip');
    expect(noteOnB?.body).toBe('Aが書いた本文');
    expect(result.receivedBlobs).toBe(1);
    expect(result.changedTerms).toBe(1);
  });

  it('#202: 同じ端末が何度pushしてもサーバーの行は1件に保たれ、カーソルは正しく進む', async () => {
    const account = await signup();
    setDataKey(account.accountId, generateDataKey());
    const a = track(makeDevice('A', account.accountId));
    const b = track(makeDevice('B', account.accountId));

    const bodies = ['1回目', '2回目', '3回目'];
    for (let i = 0; i < bodies.length; i++) {
      await a.deps.notesRepo.saveBody('tcp-ip', bodies[i], a.deps.deviceId, 300 + i);
      await runSync(a.deps, account.token);
    }
    const rows = await blobRowCount(account.accountId, a.deps.deviceId);
    step(`端末Aが3回push → サーバー上の端末Aのblob=${rows}件`);

    // 圧縮されていること(模型には無かった挙動。実サーバーでのみ確かめられる)
    expect(rows).toBe(1);

    await runSync(b.deps, account.token);
    step(await describeDevice(b, 'tcp-ip'));

    // 圧縮でseqが飛んでもカーソルは正しく進み、最新の内容が届く
    const noteOnB = await b.deps.notesRepo.getByTermId('tcp-ip');
    expect(noteOnB?.body).toBe('3回目');
    expect(await b.deps.syncStateRepo.getCursor()).toBeGreaterThan(0);

    // 追いついた後は何も受け取らない(カーソルが正しい位置にある)
    const again = await runSync(b.deps, account.token);
    expect(again.receivedBlobs).toBe(0);
  });

  it('#224: 3端末と競合したら相手ごとに記録し、内容が揃った相手だけが決着する', async () => {
    const account = await signup();
    setDataKey(account.accountId, generateDataKey());
    const a = track(makeDevice('A', account.accountId));
    const b = track(makeDevice('B', account.accountId));
    const c = track(makeDevice('C', account.accountId));

    // 3端末が同じ語を別々に編集(Aが最も新しい=newest-winsでAの版が残る)
    await a.deps.notesRepo.saveBody('tcp-ip', 'Aの版', a.deps.deviceId, 300);
    await b.deps.notesRepo.saveBody('tcp-ip', 'Bの版', b.deps.deviceId, 100);
    await c.deps.notesRepo.saveBody('tcp-ip', 'Cの版', c.deps.deviceId, 200);
    await runSync(b.deps, account.token);
    await runSync(c.deps, account.token);
    step('端末A・B・Cが「tcp-ip」を別々に編集 → B・Cがpush');

    await runSync(a.deps, account.token);
    step(await describeDevice(a, 'tcp-ip'));

    const openOnA = await a.deps.noteConflictsRepo.getOpen();
    expect(openOnA.map((x) => x.peerDeviceId).sort()).toEqual(['device-B', 'device-C']);
    const noteOnA = await a.deps.notesRepo.getByTermId('tcp-ip');
    expect(noteOnA?.body).toBe('Aの版');

    // 端末Bだけが、Aの現在の内容と同じものを送ってくる
    await b.deps.notesRepo.saveBody('tcp-ip', 'Aの版', b.deps.deviceId, 400);
    await runSync(b.deps, account.token);
    step('端末BがAの版に揃えてpush');

    await runSync(a.deps, account.token);
    step(await describeDevice(a, 'tcp-ip'));

    const afterOnA = await a.deps.noteConflictsRepo.getOpen();
    expect(afterOnA).toHaveLength(1);
    expect(afterOnA[0].peerDeviceId).toBe('device-C'); // Cとはまだ食い違っている
    const all = await a.deps.noteConflictsRepo.getAllOrdered();
    const closedWithB = all.find((x) => x.peerDeviceId === 'device-B');
    expect(closedWithB?.closedReason).toBe('converged');
  });

  it('#226: 鍵が無い端末は同期できず、サーバーに何も残さない', async () => {
    const account = await signup();
    clearDataKey(account.accountId); // 受け渡しをしていない状態
    const a = track(makeDevice('A', account.accountId));

    await a.deps.notesRepo.saveBody('tcp-ip', '鍵が無い端末の本文', a.deps.deviceId, 300);
    await expect(runSync(a.deps, account.token)).rejects.toBeInstanceOf(SyncKeyMissingError);
    step('鍵が無い端末が同期を試みる → SyncKeyMissingError');

    expect(await blobRowCount(account.accountId)).toBe(0);
  });
});
