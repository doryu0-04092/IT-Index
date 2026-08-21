import { env, exports } from 'cloudflare:workers';
import { hashPassword } from '../src/crypto';
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
  // #213: スマートフォンのキーボードが先頭を大文字にすると弾かれ、
  // 「PCでは入れるのに端末では弾かれる」状態になっていた。
  it('メールの大文字小文字が違ってもログインできる(#213)', async () => {
    const email = `user-${crypto.randomUUID()}@example.com`;
    expect((await signup(email, 'TestPass2026')).status).toBe(201);

    // 先頭だけ大文字にした形(Androidのキーボードがしがちな形)
    const capitalized = email.charAt(0).toUpperCase() + email.slice(1);
    expect(capitalized).not.toBe(email);
    expect((await login(capitalized, 'TestPass2026')).status).toBe(200);

    // 全部大文字でも引ける
    expect((await login(email.toUpperCase(), 'TestPass2026')).status).toBe(200);

    // パスワードの側は区別したまま(こちらを吸収してはいけない)
    expect((await login(email, 'testpass2026')).status).toBe(401);
  });

  it('大文字違いの二重登録はできない(#213)', async () => {
    const email = `user-${crypto.randomUUID()}@example.com`;
    expect((await signup(email, 'TestPass2026')).status).toBe(201);

    const res = await signup(email.toUpperCase(), 'TestPass2026');
    expect(res.status).toBe(409);
  });

  it('signup -> login -> me', async () => {
    const email = `user-${crypto.randomUUID()}@example.com`;
    const signupRes = await signup(email, 'TestPass2026');
    expect(signupRes.status).toBe(201);
    const signupBody = await signupRes.json<{ token: string }>();
    expect(typeof signupBody.token).toBe('string');

    const loginRes = await login(email, 'TestPass2026');
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
    const first = await signup(email, 'TestPass2026');
    expect(first.status).toBe(201);

    const second = await signup(email, 'TestPass2026');
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

  // パスワード要件(#205)。判定はshared/core/passwordPolicyにあり、ここでは
  // 「エンドポイントが実際に弾くこと」だけを確かめる——画面の検証はこのAPIを
  // 直接叩けば迂回できるため、防御が成立しているのはサーバー側だけ。
  it('文字数を満たしても英大文字・英小文字・数字が欠けていれば400', async () => {
    for (const password of ['abcdefghij', 'ABCDEFGHIJ', 'Abcdefghij', 'abcdefgh12']) {
      const email = `types-${crypto.randomUUID()}@example.com`;
      const res = await signup(email, password);
      expect(res.status, password).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('weak_password');
    }
  });

  it('文字種の条件を満たしていても、よく使われるパスワードは400', async () => {
    const email = `common-${crypto.randomUUID()}@example.com`;
    const res = await signup(email, 'Password1');
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('weak_password');
    expect(body.error.message).toContain('よく使われている');
  });

  // 回帰防止。ログイン側に要件の検証を足すと、パスワード再設定の導線が無いこのアプリでは
  // 条件に該当する既存アカウントが永久にログイン不能になる。
  it('要件を満たさない既存アカウントでもログインできる(ログインでは検証しない)', async () => {
    const email = `legacy-${crypto.randomUUID()}@example.com`;
    const weak = 'password123'; // 現在の要件では登録できない(大文字なし・ブロックリスト該当)

    // 要件の追加前に作られたアカウントを再現するため、signupを通さずDBへ直接入れる
    expect((await signup(`pre-${email}`, weak)).status).toBe(400);
    await env.DB.prepare(
      'INSERT INTO accounts (id, email, password_hash, created_at) VALUES (?1, ?2, ?3, ?4)'
    )
      .bind(crypto.randomUUID(), email, await hashPassword(weak), Date.now())
      .run();

    const res = await login(email, weak);
    expect(res.status).toBe(200);
  });

  it('login with wrong password returns 401 without revealing whether the email exists', async () => {
    const email = `wrongpw-${crypto.randomUUID()}@example.com`;
    await signup(email, 'TestPass2026');

    const wrongPassword = await login(email, 'wrongpassword');
    const unknownEmail = await login(`unknown-${crypto.randomUUID()}@example.com`, 'TestPass2026');

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
