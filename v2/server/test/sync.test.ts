import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { BASE, authHeaders, signupAccount } from './helpers';

// 同期は公式ホストでは要ライセンス(src/license.ts)。ここでは同期そのものの振る舞いを
// 見たいので、アカウントには既定でライセンスを付与する。
// 未ライセンス時に403になることはlicense.test.tsで検証する。
async function signupAndGetToken(): Promise<string> {
  return (await signupAccount('sync')).token;
}

async function push(token: string, deviceId: string, payload: string) {
  return exports.default.fetch(`${BASE}/api/sync/push`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ deviceId, payload }),
  });
}

async function pull(token: string, since: number) {
  return exports.default.fetch(`${BASE}/api/sync/pull?since=${since}`, {
    headers: authHeaders(token),
  });
}

describe('blobの圧縮(#202)', () => {
  it('同じ端末が再pushすると、その端末の古い行は消える(1端末1行)', async () => {
    const token = await signupAndGetToken();

    await push(token, 'device-a', JSON.stringify({ v: 1 }));
    await push(token, 'device-a', JSON.stringify({ v: 2 }));
    await push(token, 'device-a', JSON.stringify({ v: 3 }));

    const body = await (await pull(token, 0)).json<{
      blobs: Array<{ seq: number; deviceId: string; payload: string }>;
      latest: number;
    }>();

    // 端末が送るのは全量スナップショットなので、最新1件あれば足りる
    expect(body.blobs).toHaveLength(1);
    expect(body.blobs[0].payload).toBe(JSON.stringify({ v: 3 }));
    expect(body.latest).toBe(3);
  });

  it('他端末の行は消さない(端末ごとに1行ずつ残る)', async () => {
    const token = await signupAndGetToken();

    await push(token, 'device-a', JSON.stringify({ from: 'a1' }));
    await push(token, 'device-b', JSON.stringify({ from: 'b1' }));
    await push(token, 'device-a', JSON.stringify({ from: 'a2' }));

    const body = await (await pull(token, 0)).json<{
      blobs: Array<{ deviceId: string; payload: string }>;
    }>();

    expect(body.blobs).toHaveLength(2);
    const byDevice = new Map(body.blobs.map((b) => [b.deviceId, b.payload]));
    expect(byDevice.get('device-a')).toBe(JSON.stringify({ from: 'a2' }));
    expect(byDevice.get('device-b')).toBe(JSON.stringify({ from: 'b1' }));
  });

  it('latestは減らない(クライアントのcursor自己修復を誤発火させない)', async () => {
    const token = await signupAndGetToken();

    const first = await (await push(token, 'device-a', '{}')).json<{ seq: number }>();
    const second = await (await push(token, 'device-a', '{}')).json<{ seq: number }>();
    const body = await (await pull(token, 0)).json<{ latest: number }>();

    // 古い行が消えてもlatestは常に「直前に挿入した行」なので単調増加する。
    // ここが減ると、cursorがlatestを追い越して全件の読み直しが起きてしまう(#182)
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(body.latest).toBe(second.seq);
  });

  it('圧縮後もcursorから先だけが返る(取りこぼさない)', async () => {
    const token = await signupAndGetToken();

    await push(token, 'device-a', JSON.stringify({ n: 1 }));
    const b1 = await (await push(token, 'device-b', JSON.stringify({ n: 2 }))).json<{ seq: number }>();
    await push(token, 'device-a', JSON.stringify({ n: 3 }));

    // device-b のcursor(自分がpushしたseq)以降を取りに行く
    const body = await (await pull(token, b1.seq)).json<{ blobs: Array<{ deviceId: string }> }>();

    // device-a の最新(全量スナップショット)が届く。消えた古い行の内容も含まれている
    expect(body.blobs.map((b) => b.deviceId)).toEqual(['device-a']);
  });

  it('他アカウントの行は消さない', async () => {
    const a = await signupAndGetToken();
    const b = await signupAndGetToken();

    await push(a, 'device-x', '{}');
    await push(b, 'device-x', '{}'); // 同じdeviceIdでも別アカウント
    await push(a, 'device-x', '{}');

    const bodyB = await (await pull(b, 0)).json<{ blobs: unknown[] }>();
    expect(bodyB.blobs).toHaveLength(1);
  });
});

describe('sync', () => {
  it('push then pull round trip', async () => {
    const token = await signupAndGetToken();
    const payload = JSON.stringify({ hello: 'world' });

    const pushRes = await push(token, 'device-a', payload);
    expect(pushRes.status).toBe(201);
    const pushBody = await pushRes.json<{ seq: number }>();
    expect(pushBody.seq).toBe(1);

    const pullRes = await pull(token, 0);
    expect(pullRes.status).toBe(200);
    const pullBody = await pullRes.json<{
      blobs: Array<{ seq: number; deviceId: string; payload: string; createdAt: number }>;
      latest: number;
    }>();
    expect(pullBody.latest).toBe(1);
    expect(pullBody.blobs).toHaveLength(1);
    expect(pullBody.blobs[0]).toMatchObject({ seq: 1, deviceId: 'device-a', payload });
    expect(typeof pullBody.blobs[0].createdAt).toBe('number');
  });

  it('seq increases monotonically per account regardless of device', async () => {
    const token = await signupAndGetToken();
    const seqs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await push(token, `device-${i}`, `payload-${i}`);
      expect(res.status).toBe(201);
      const body = await res.json<{ seq: number }>();
      seqs.push(body.seq);
    }
    expect(seqs).toEqual([1, 2, 3]);
  });

  it('pull with since filters out already-seen blobs', async () => {
    const token = await signupAndGetToken();
    for (let i = 0; i < 3; i++) {
      await push(token, 'device-a', `payload-${i}`);
    }

    const res = await pull(token, 2);
    expect(res.status).toBe(200);
    const body = await res.json<{ blobs: Array<{ seq: number; payload: string }>; latest: number }>();
    expect(body.blobs.map((b) => b.seq)).toEqual([3]);
    expect(body.blobs[0].payload).toBe('payload-2');
    expect(body.latest).toBe(3);
  });

  it('push without auth returns 401', async () => {
    const res = await exports.default.fetch(`${BASE}/api/sync/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'x', payload: 'y' }),
    });
    expect(res.status).toBe(401);
  });

  it('pull without auth returns 401', async () => {
    const res = await pull('not-a-real-token', 0);
    expect(res.status).toBe(401);
  });

  it('payload over 1MB returns 413', async () => {
    const token = await signupAndGetToken();
    const oversizedPayload = 'a'.repeat(1024 * 1024 + 1);

    const res = await push(token, 'device-a', oversizedPayload);
    expect(res.status).toBe(413);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('payload_too_large');
  });
});
