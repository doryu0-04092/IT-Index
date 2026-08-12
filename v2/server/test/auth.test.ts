import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const BASE = 'https://example.com';

async function signup(email: string, password: string) {
  return exports.default.fetch(`${BASE}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

async function login(email: string, password: string) {
  return exports.default.fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

describe('health', () => {
  it('returns ok', async () => {
    const res = await exports.default.fetch(`${BASE}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('auth', () => {
  it('signup -> login -> me', async () => {
    const email = `user-${crypto.randomUUID()}@example.com`;
    const signupRes = await signup(email, 'password123');
    expect(signupRes.status).toBe(201);
    const signupBody = await signupRes.json<{ token: string }>();
    expect(typeof signupBody.token).toBe('string');

    const loginRes = await login(email, 'password123');
    expect(loginRes.status).toBe(200);
    const loginBody = await loginRes.json<{ token: string }>();

    const meRes = await exports.default.fetch(`${BASE}/api/auth/me`, {
      headers: { authorization: `Bearer ${loginBody.token}` },
    });
    expect(meRes.status).toBe(200);
    const me = await meRes.json<{ accountId: string; email: string; licensed: boolean }>();
    expect(me.email).toBe(email);
    expect(typeof me.accountId).toBe('string');
    // 作成直後のアカウントはライセンスを持たない(公式ホストの既定=ゲート有効)。
    expect(me.licensed).toBe(false);
  });

  it('duplicate signup returns 409', async () => {
    const email = `dup-${crypto.randomUUID()}@example.com`;
    const first = await signup(email, 'password123');
    expect(first.status).toBe(201);

    const second = await signup(email, 'password123');
    expect(second.status).toBe(409);
    const body = await second.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('email_taken');
  });

  it('password shorter than 8 chars returns 400', async () => {
    const email = `short-${crypto.randomUUID()}@example.com`;
    const res = await signup(email, '1234567');
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('weak_password');
  });

  it('login with wrong password returns 401 without revealing whether the email exists', async () => {
    const email = `wrongpw-${crypto.randomUUID()}@example.com`;
    await signup(email, 'password123');

    const wrongPassword = await login(email, 'wrongpassword');
    const unknownEmail = await login(`unknown-${crypto.randomUUID()}@example.com`, 'password123');

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    const wrongBody = await wrongPassword.json<{ error: { code: string; message: string } }>();
    const unknownBody = await unknownEmail.json<{ error: { code: string; message: string } }>();
    expect(wrongBody.error.message).toBe(unknownBody.error.message);
  });

  it('me without a token returns 401', async () => {
    const res = await exports.default.fetch(`${BASE}/api/auth/me`);
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('unauthorized');
  });
});
