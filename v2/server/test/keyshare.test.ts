import { exports, env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { BASE, authHeaders, signupAccount } from './helpers';

// 鍵の受け渡し(#182)は同期のための機能なので、同期と同じく要ライセンス。
// ここでは受け渡しそのものの振る舞いを見たいのでライセンスを付与する。
async function signupAndGetToken(): Promise<string> {
  return (await signupAccount('keyshare')).token;
}

async function putShare(token: string, salt: string, wrappedDk: string) {
  return exports.default.fetch(`${BASE}/api/sync/keyshare`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: JSON.stringify({ salt, wrappedDk }),
  });
}

async function getShare(token: string) {
  return exports.default.fetch(`${BASE}/api/sync/keyshare`, { headers: authHeaders(token) });
}

async function deleteShare(token: string) {
  return exports.default.fetch(`${BASE}/api/sync/keyshare`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
}

async function deleteBlobs(token: string) {
  return exports.default.fetch(`${BASE}/api/sync/blobs`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
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

describe('鍵の受け渡し', () => {
  it('置いて取り出せる(サーバーは暗号文とsaltだけを返す)', async () => {
    const token = await signupAndGetToken();

    const putRes = await putShare(token, 'c2FsdA==', 'd3JhcHBlZA==');
    expect(putRes.status).toBe(201);
    const putBody = await putRes.json<{ expiresAt: number }>();
    expect(putBody.expiresAt).toBeGreaterThan(Date.now());

    const getRes = await getShare(token);
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual({ salt: 'c2FsdA==', wrappedDk: 'd3JhcHBlZA==' });
  });

  it('認証なしは401', async () => {
    const res = await exports.default.fetch(`${BASE}/api/sync/keyshare`, {
      headers: authHeaders('not-a-real-token'),
    });
    expect(res.status).toBe(401);
  });

  it('準備されていなければ404', async () => {
    const token = await signupAndGetToken();
    const res = await getShare(token);
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('keyshare_not_found');
  });

  it('2回目のPUTは上書きになる(1アカウント1件。やり直しで古い受け渡しが無効になる)', async () => {
    const token = await signupAndGetToken();
    await putShare(token, 'c2FsdDE=', 'd3JhcDE=');
    await putShare(token, 'c2FsdDI=', 'd3JhcDI=');

    const body = await (await getShare(token)).json<{ salt: string; wrappedDk: string }>();
    expect(body).toEqual({ salt: 'c2FsdDI=', wrappedDk: 'd3JhcDI=' });
  });

  it('DELETE後は取り出せない(受け取り成功時に消す経路)', async () => {
    const token = await signupAndGetToken();
    await putShare(token, 'c2FsdA==', 'd3JhcHBlZA==');

    expect((await deleteShare(token)).status).toBe(200);
    expect((await getShare(token)).status).toBe(404);
  });

  it('取り出しは5回まで。6回目で行ごと破棄される(総当たり対策)', async () => {
    const token = await signupAndGetToken();
    await putShare(token, 'c2FsdA==', 'd3JhcHBlZA==');

    for (let i = 1; i <= 5; i++) {
      expect((await getShare(token)).status).toBe(200);
    }
    expect((await getShare(token)).status).toBe(404);
    // 破棄済みなので、その後も戻らない
    expect((await getShare(token)).status).toBe(404);
  });

  it('期限切れは取り出せず、行ごと破棄される', async () => {
    const { token, accountId } = await signupAccount('keyshare-exp');
    await putShare(token, 'c2FsdA==', 'd3JhcHBlZA==');

    // TTLの経過をDB直更新で再現する(時計を進める代わり)
    await env.DB.prepare('UPDATE key_shares SET expires_at = ?2 WHERE account_id = ?1')
      .bind(accountId, Date.now() - 1)
      .run();

    expect((await getShare(token)).status).toBe(404);
    const row = await env.DB.prepare('SELECT account_id FROM key_shares WHERE account_id = ?1')
      .bind(accountId)
      .first();
    expect(row).toBeNull();
  });

  it('他アカウントの受け渡しは引けない', async () => {
    const a = await signupAndGetToken();
    const b = await signupAndGetToken();
    await putShare(a, 'c2FsdA==', 'd3JhcHBlZA==');

    expect((await getShare(b)).status).toBe(404);
    // aのぶんは消費されていない
    expect((await getShare(a)).status).toBe(200);
  });

  it('検証エラー: saltまたはwrappedDkが無ければ400', async () => {
    const token = await signupAndGetToken();
    const res = await exports.default.fetch(`${BASE}/api/sync/keyshare`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: JSON.stringify({ salt: 'c2FsdA==' }),
    });
    expect(res.status).toBe(400);
  });

  it('検証エラー: 想定外に大きな値は400', async () => {
    const token = await signupAndGetToken();
    const res = await putShare(token, 'c2FsdA==', 'x'.repeat(4097));
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/sync/blobs', () => {
  it('自アカウントの差分を全部消す。seqは1から振り直しになる', async () => {
    const token = await signupAndGetToken();
    await push(token, 'device-a', JSON.stringify({ a: 1 }));
    await push(token, 'device-a', JSON.stringify({ a: 2 }));

    const res = await deleteBlobs(token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 2 });

    const pulled = await (await pull(token, 0)).json<{ blobs: unknown[]; latest: number }>();
    expect(pulled.blobs).toHaveLength(0);
    expect(pulled.latest).toBe(0);

    // 消した後のpushは1から振り直し(クライアントのcursor自己修復が必要になる根拠)
    const again = await push(token, 'device-a', JSON.stringify({ a: 3 }));
    expect((await again.json<{ seq: number }>()).seq).toBe(1);
  });

  it('他アカウントの差分は消さない', async () => {
    const a = await signupAndGetToken();
    const b = await signupAndGetToken();
    await push(a, 'device-a', JSON.stringify({ a: 1 }));
    await push(b, 'device-b', JSON.stringify({ b: 1 }));

    await deleteBlobs(a);

    const pulledB = await (await pull(b, 0)).json<{ blobs: unknown[] }>();
    expect(pulledB.blobs).toHaveLength(1);
  });
});
