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
