import { Hono } from 'hono';
import type { Env } from './types';
import { hashPassword, verifyPassword } from './crypto';
import { issueToken, requireAuth, type AuthedVariables } from './auth';
import { insertSyncBlob, isUniqueConstraintError, pullSyncBlobs } from './db';

const MIN_PASSWORD_LENGTH = 8;
const MAX_PAYLOAD_BYTES = 1024 * 1024;

const app = new Hono<{ Bindings: Env; Variables: AuthedVariables }>();

app.get('/api/health', (c) => c.json({ status: 'ok' }));

app.post('/api/auth/signup', async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>().catch(() => null);
  const email = body?.email?.trim();
  const password = body?.password;

  if (!email || !password) {
    return c.json({ error: { code: 'invalid_request', message: 'emailとpasswordが必要です' } }, 400);
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return c.json(
      { error: { code: 'weak_password', message: 'パスワードは8文字以上で入力してください' } },
      400
    );
  }

  const existing = await c.env.DB.prepare('SELECT id FROM accounts WHERE email = ?1')
    .bind(email)
    .first();
  if (existing) {
    return c.json(
      { error: { code: 'email_taken', message: 'このメールアドレスは既に使用されています' } },
      409
    );
  }

  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  const createdAt = Date.now();
  try {
    await c.env.DB.prepare(
      'INSERT INTO accounts (id, email, password_hash, created_at) VALUES (?1, ?2, ?3, ?4)'
    )
      .bind(id, email, passwordHash, createdAt)
      .run();
  } catch (err) {
    // 事前SELECTとINSERTの間に同じemailで登録が走った場合、UNIQUE制約違反になる。
    // 500ではなく通常の重複(409)として返す。
    if (isUniqueConstraintError(err)) {
      return c.json(
        { error: { code: 'email_taken', message: 'このメールアドレスは既に使用されています' } },
        409
      );
    }
    throw err;
  }

  const token = await issueToken(id, c.env.JWT_SECRET);
  return c.json({ token }, 201);
});

app.post('/api/auth/login', async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>().catch(() => null);
  const email = body?.email?.trim();
  const password = body?.password;

  // emailの存在有無を区別しないため、未入力・未登録・パスワード不一致のいずれも同じ応答にする。
  const invalidCredentials = () =>
    c.json(
      {
        error: {
          code: 'invalid_credentials',
          message: 'メールアドレスまたはパスワードが正しくありません',
        },
      },
      401
    );

  if (!email || !password) return invalidCredentials();

  const account = await c.env.DB.prepare('SELECT id, password_hash FROM accounts WHERE email = ?1')
    .bind(email)
    .first<{ id: string; password_hash: string }>();
  if (!account) return invalidCredentials();

  const ok = await verifyPassword(password, account.password_hash);
  if (!ok) return invalidCredentials();

  const token = await issueToken(account.id, c.env.JWT_SECRET);
  return c.json({ token }, 200);
});

app.get('/api/auth/me', requireAuth, async (c) => {
  const accountId = c.get('accountId');
  const account = await c.env.DB.prepare('SELECT id, email FROM accounts WHERE id = ?1')
    .bind(accountId)
    .first<{ id: string; email: string }>();
  if (!account) {
    return c.json({ error: { code: 'unauthorized', message: '認証が必要です' } }, 401);
  }
  return c.json({ accountId: account.id, email: account.email });
});

app.post('/api/sync/push', requireAuth, async (c) => {
  const contentLength = c.req.header('content-length');
  if (contentLength && Number(contentLength) > MAX_PAYLOAD_BYTES) {
    return c.json(
      { error: { code: 'payload_too_large', message: 'payloadが1MBを超えています' } },
      413
    );
  }

  const body = await c.req.json<{ deviceId?: string; payload?: string }>().catch(() => null);
  const deviceId = body?.deviceId;
  const payload = body?.payload;
  if (!deviceId || typeof payload !== 'string') {
    return c.json(
      { error: { code: 'invalid_request', message: 'deviceIdとpayloadが必要です' } },
      400
    );
  }
  if (new TextEncoder().encode(payload).byteLength > MAX_PAYLOAD_BYTES) {
    return c.json(
      { error: { code: 'payload_too_large', message: 'payloadが1MBを超えています' } },
      413
    );
  }

  const accountId = c.get('accountId');
  const seq = await insertSyncBlob(c.env.DB, accountId, deviceId, payload);
  return c.json({ seq }, 201);
});

app.get('/api/sync/pull', requireAuth, async (c) => {
  const sinceRaw = c.req.query('since') ?? '0';
  const since = Number(sinceRaw);
  if (!Number.isFinite(since) || since < 0) {
    return c.json(
      { error: { code: 'invalid_request', message: 'sinceは0以上の数値で指定してください' } },
      400
    );
  }

  const accountId = c.get('accountId');
  const { blobs, latest } = await pullSyncBlobs(c.env.DB, accountId, since);
  return c.json({
    blobs: blobs.map((row) => ({
      seq: row.seq,
      deviceId: row.device_id,
      payload: row.payload,
      createdAt: row.created_at,
    })),
    latest,
  });
});

export default app;
