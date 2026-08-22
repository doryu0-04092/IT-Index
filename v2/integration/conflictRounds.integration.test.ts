import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ItIndexDB } from '../client/src/db';
import { createAsksRepository } from '../client/src/repositories/asks';
import { createNoteConflictsRepository } from '../client/src/repositories/noteConflicts';
import { createNotesRepository } from '../client/src/repositories/notes';
import { createSyncEventsRepository } from '../client/src/repositories/syncEvents';
import { createSyncStateRepository } from '../client/src/repositories/syncState';
import { createTermsRepository } from '../client/src/repositories/terms';
import { groupConflictsByTerm, MAX_CONFLICT_DEVICES } from '../client/src/sync/groupConflicts';
import { setServerBaseUrl } from '../client/src/sync/serverConfig';
import { generateDataKey } from '../client/src/sync/syncCrypto';
import { runSync, type SyncEngineDeps } from '../client/src/sync/syncEngine';
import { setDataKey } from '../client/src/sync/syncKeyStore';

/**
 * 5端末で競合を**繰り返し**起こしたときに壊れないかを、実サーバー相手に確かめる(本人指定)。
 *
 * 見たいのは1回の競合ではなく**経過**:
 *
 * 1. 5端末が同じ語を別内容にして競合させる
 * 2. 競合が残っている状態で、**同じ語をまた別内容にして**競合を起こす
 * 3. 解消した後に、**また競合を起こす**
 * 4. 起こす端末は1台だけでなく**複数**にする
 *
 * 「1回やって期待どおり」では足りない——#157で競合行が積み上がる不具合、#224で
 * 相手ごとに記録されない不具合が出ているのは、いずれも**繰り返した時**に露見する形だった。
 */

const BASE = 'https://example.com';
const TERM = 'tcp-ip';
const DEVICE_NAMES = ['A', 'B', 'C', 'D', 'E'] as const;
type DeviceName = (typeof DEVICE_NAMES)[number];

const timeline: string[] = [];
function step(text: string) {
  timeline.push(text);
}

interface Device {
  name: DeviceName;
  db: ItIndexDB;
  deps: SyncEngineDeps;
}

function makeDevice(name: DeviceName, accountId: string): Device {
  const db = new ItIndexDB(`conflict-${name}-${crypto.randomUUID()}`);
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
      holdLocalOnConflict: false, // PC相当(解消できる側)
    },
  };
}

/** 未解決の競合の相手を並べる(A→['B','C'] の形) */
async function openPeers(d: Device): Promise<string[]> {
  const open = await d.deps.noteConflictsRepo.getOpen();
  return open.map((c) => c.peerDeviceId.replace('device-', '')).sort();
}

/** 決着済みを「相手:理由」で並べる */
async function closedPeers(d: Device): Promise<string[]> {
  const all = await d.deps.noteConflictsRepo.getAllOrdered();
  return all
    .filter((c) => c.resolution !== null || c.closedReason !== null)
    .map((c) => `${c.peerDeviceId.replace('device-', '')}:${c.resolution ?? c.closedReason}`)
    .sort();
}

async function describe1(d: Device): Promise<string> {
  const note = await d.deps.notesRepo.getByTermId(TERM);
  const open = await openPeers(d);
  const closed = await closedPeers(d);
  const rows = (await d.deps.noteConflictsRepo.getAllOrdered()).length;
  return `端末${d.name}: ノート="${note?.body ?? '(無し)'}" 未解決[${open.join(',')}] 決着[${closed.join(',')}] 行数=${rows}`;
}

/**
 * その端末の未解決競合を「この端末の内容を採用」で解消する。
 * 画面(useConflictResolution)がやっているのと同じ2手順を踏む——
 * ノートへ反映してから競合へ選択を記録する。フックはReact依存なのでここでは直接呼ぶ。
 */
async function resolveAllAsLocal(d: Device, at: number) {
  const open = await d.deps.noteConflictsRepo.getOpen();
  for (const conflict of open) {
    await d.deps.notesRepo.applyConflictResolution(
      conflict.termId,
      conflict.local.body,
      conflict.local.diagrams,
      d.deps.deviceId,
      at,
      { body: conflict.remote.body, diagrams: conflict.remote.diagrams },
    );
    await d.deps.noteConflictsRepo.setResolution(conflict.id, 'local', null, at);
  }
}

async function signup(): Promise<{ token: string; accountId: string }> {
  const email = `conflict-${crypto.randomUUID()}@example.com`;
  const res = await exports.default.fetch(`${BASE}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'TestPass2026' }),
  });
  expect(res.status).toBe(201);
  const body = await res.json<{ token: string }>();
  const row = await env.DB.prepare('SELECT id FROM accounts WHERE email = ?1')
    .bind(email.toLowerCase())
    .first<{ id: string }>();
  if (row === null) throw new Error('作成したアカウントが引けない');
  return { token: body.token, accountId: row.id };
}

let originalFetch: typeof globalThis.fetch;
const openDbs: ItIndexDB[] = [];

beforeEach(() => {
  timeline.length = 0;
  originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    exports.default.fetch(String(input), init)) as typeof fetch;
  setServerBaseUrl(BASE);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const db of openDbs) db.close();
  openDbs.length = 0;
  localStorage.clear();
  if (timeline.length > 0) console.log('\n' + timeline.map((t) => `  ${t}`).join('\n'));
});

describe('5端末で競合を繰り返す(実サーバー)', () => {
  it('競合→再競合→解消→再競合の各段階で、記録が壊れず想定どおりに変化する', async () => {
    const account = await signup();
    setDataKey(account.accountId, generateDataKey()); // 全端末が同じ鍵を持つ状態
    const devices = DEVICE_NAMES.map((name) => {
      const d = makeDevice(name, account.accountId);
      openDbs.push(d.db);
      return d;
    });
    const byName = new Map<DeviceName, Device>(devices.map((d) => [d.name, d]));
    const a = byName.get('A')!;

    /* ── 第1ラウンド: 5端末が同じ語を別内容にする ───────────────────────── */
    // Aを最も新しくして、Aのノートが newest-wins で残る形にする(観察しやすくするため)
    const round1 = { A: 500, B: 100, C: 200, D: 300, E: 400 } as const;
    for (const d of devices) {
      await d.deps.notesRepo.saveBody(TERM, `${d.name}の版1`, d.deps.deviceId, round1[d.name]);
    }
    for (const d of devices) {
      if (d.name !== 'A') await runSync(d.deps, account.token);
    }
    await runSync(a.deps, account.token);
    step('R1: 5端末が同じ語を別内容に → B〜Eがpush → Aが同期');
    step(await describe1(a));

    // 相手ごとに1件ずつ、4件立つ
    expect(await openPeers(a)).toEqual(['B', 'C', 'D', 'E']);
    const noteAfterR1 = await a.deps.notesRepo.getByTermId(TERM);
    expect(noteAfterR1?.body).toBe('Aの版1');

    // 1グループに自分+4台がまとまる(上限5台以内なので隠れない)
    const groups1 = groupConflictsByTerm(await a.deps.noteConflictsRepo.getOpen());
    expect(groups1).toHaveLength(1);
    expect(groups1[0].conflicts).toHaveLength(4);
    expect(groups1[0].hiddenCount).toBe(0);
    expect(4).toBeLessThanOrEqual(MAX_CONFLICT_DEVICES);

    /* ── 第2ラウンド: 競合が残ったまま、複数端末がまた別内容にする ───────── */
    for (const name of ['B', 'C'] as const) {
      const d = byName.get(name)!;
      await d.deps.notesRepo.saveBody(TERM, `${name}の版2`, d.deps.deviceId, 600 + DEVICE_NAMES.indexOf(name));
      await runSync(d.deps, account.token);
    }
    await runSync(a.deps, account.token);
    step('R2: 競合が残ったままB・Cがまた別内容に → push → Aが同期');
    step(await describe1(a));

    // **行が増えない**(#157: 論理競合1件=open行1件に正規化)
    expect(await openPeers(a)).toEqual(['B', 'C', 'D', 'E']);
    expect(await a.deps.noteConflictsRepo.getAllOrdered()).toHaveLength(4);
    // B・Cのスナップショットは新しい内容へ更新されている
    const openR2 = await a.deps.noteConflictsRepo.getOpen();
    expect(openR2.find((c) => c.peerDeviceId === 'device-B')?.remote.body).toBe('Bの版2');
    expect(openR2.find((c) => c.peerDeviceId === 'device-C')?.remote.body).toBe('Cの版2');
    // D・Eは触っていないので初回のまま
    expect(openR2.find((c) => c.peerDeviceId === 'device-D')?.remote.body).toBe('Dの版1');

    /* ── 第3ラウンド: Aが解消する ────────────────────────────────────── */
    await resolveAllAsLocal(a, 700);
    await runSync(a.deps, account.token);
    step('R3: Aが「この端末の内容」で全件解消 → push');
    step(await describe1(a));

    expect(await openPeers(a)).toEqual([]);
    expect(await closedPeers(a)).toEqual(['B:local', 'C:local', 'D:local', 'E:local']);

    /* ── 第4ラウンド: 解消後にまた競合させる(複数端末) ──────────────────── */
    for (const name of ['B', 'D'] as const) {
      const d = byName.get(name)!;
      await runSync(d.deps, account.token); // Aの決定を受け取る
      await d.deps.notesRepo.saveBody(TERM, `${name}の版3`, d.deps.deviceId, 800 + DEVICE_NAMES.indexOf(name));
      await runSync(d.deps, account.token);
    }
    await runSync(a.deps, account.token);
    step('R4: 解消後にB・Dがまた別内容に → push → Aが同期');
    step(await describe1(a));

    // **新しい競合として立つ**(決着済みの行は履歴として残ったまま)
    expect(await openPeers(a)).toEqual(['B', 'D']);
    const closedAfterR4 = await closedPeers(a);
    expect(closedAfterR4).toContain('C:local');
    expect(closedAfterR4).toContain('E:local');

    // 解消済みの行が再びopenに戻っていないこと(戻ると「解消した記録」が消える)
    const allAfterR4 = await a.deps.noteConflictsRepo.getAllOrdered();
    const reopened = allAfterR4.filter(
      (c) => c.resolution === null && c.closedReason === null && c.resolvedAt !== null,
    );
    expect(reopened).toEqual([]);

    /* ── 第5ラウンド: もう一度解消して、収束することを見る ───────────────── */
    await resolveAllAsLocal(a, 900);
    await runSync(a.deps, account.token);
    for (const name of ['B', 'D'] as const) await runSync(byName.get(name)!.deps, account.token);
    await runSync(a.deps, account.token);
    step('R5: Aがもう一度解消 → B・Dが同期して受け取る → Aが同期');
    step(await describe1(a));
    step(await describe1(byName.get('B')!));

    // Aは未解決0のまま(受け取り直しで蒸し返らない)
    expect(await openPeers(a)).toEqual([]);
    // B側もAの決定と同じ内容へ収束している
    const noteOnB = await byName.get('B')!.deps.notesRepo.getByTermId(TERM);
    const noteOnA = await a.deps.notesRepo.getByTermId(TERM);
    expect(noteOnB?.body).toBe(noteOnA?.body);
  });

  /**
   * 競合の相手が上限(5台)を超えた場合。1枚に出せる数を超えても**記録は落とさない**
   * ——落とすと履歴から辿れなくなる。表示側だけが hiddenCount で畳む。
   */
  it('相手が上限(5台)を超えても記録は残り、表示だけが畳まれる', async () => {
    const account = await signup();
    setDataKey(account.accountId, generateDataKey());
    const names = ['A', 'B', 'C', 'D', 'E'] as const;
    const devices = names.map((name) => {
      const d = makeDevice(name, account.accountId);
      openDbs.push(d.db);
      return d;
    });
    // 6台目以降を模す端末を2つ足す(Aから見た相手を6台にする)
    for (const extra of ['F', 'G']) {
      const db = new ItIndexDB(`conflict-${extra}-${crypto.randomUUID()}`);
      openDbs.push(db);
      devices.push({
        name: extra as DeviceName,
        db,
        deps: {
          db,
          termsRepo: createTermsRepository(db),
          notesRepo: createNotesRepository(db),
          asksRepo: createAsksRepository(db),
          noteConflictsRepo: createNoteConflictsRepository(db),
          syncEventsRepo: createSyncEventsRepository(db),
          syncStateRepo: createSyncStateRepository(db),
          accountId: account.accountId,
          deviceId: `device-${extra}`,
          holdLocalOnConflict: false,
        },
      });
    }

    const a = devices[0];
    for (const [i, d] of devices.entries()) {
      await d.deps.notesRepo.saveBody(TERM, `${d.name}の版`, d.deps.deviceId, d.name === 'A' ? 900 : 100 + i);
    }
    for (const d of devices) {
      if (d.name !== 'A') await runSync(d.deps, account.token);
    }
    await runSync(a.deps, account.token);
    step('6台の相手と競合させる');
    step(await describe1(a));

    // 記録は6件すべて残る
    expect(await openPeers(a)).toEqual(['B', 'C', 'D', 'E', 'F', 'G']);

    // 表示は上限で畳まれ、落とした件数が分かる
    const group = groupConflictsByTerm(await a.deps.noteConflictsRepo.getOpen())[0];
    expect(group.conflicts).toHaveLength(MAX_CONFLICT_DEVICES);
    expect(group.hiddenCount).toBe(1);
  });
});
