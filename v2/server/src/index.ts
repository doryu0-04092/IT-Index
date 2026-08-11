import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import { hashPassword, verifyPassword } from './crypto';
import { issueToken, requireAuth, type AuthedVariables } from './auth';
import {
  AI_GLOBAL_USAGE_ACCOUNT_ID,
  getAiUsageCount,
  incrementAiUsage,
  insertSyncBlob,
  isUniqueConstraintError,
  pullSyncBlobs,
  todayUtc,
} from './db';
import { callAi, resolveProvider, validateChatRequest } from './ai';

const MIN_PASSWORD_LENGTH = 8;
const MAX_PAYLOAD_BYTES = 1024 * 1024;

const app = new Hono<{ Bindings: Env; Variables: AuthedVariables }>();

// CORS_ALLOWED_ORIGIN未設定時は何もしない(本番は同一オリジン配信のためCORS不要)。
// ローカル開発でvite dev(5173)からwrangler dev(8787)を叩く場合のみ設定する。
app.use('/api/*', async (c, next) => {
  const allowedOrigin = c.env.CORS_ALLOWED_ORIGIN;
  if (!allowedOrigin) {
    await next();
    return;
  }
  return cors({ origin: allowedOrigin })(c, next);
});

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

app.post('/api/ai/chat', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  const validation = validateChatRequest(body);
  if (!validation.ok) {
    return c.json({ error: { code: 'invalid_request', message: validation.error } }, 400);
  }

  // 利用者持ち込みキー(BYOK)はOpenAI経路のみ対応(docs/v2/architecture.md §5)。
  // Anthropic運用時に黙ってサーバー側キーへ落とすと「キーを付ければ上限を回避できる」
  // 抜け道になるため、明示的に400で断る。
  const userApiKey = validation.userApiKey;
  if (userApiKey !== undefined && resolveProvider(c.env) !== 'openai') {
    return c.json(
      {
        error: {
          code: 'user_api_key_unsupported',
          message: 'このサーバーでは自分のAPIキーを使えません',
        },
      },
      400
    );
  }

  // 利用者が自分のキーを使う場合は費用が本人負担のため、回数上限の判定もカウントも行わない
  // (ai_usageに一切書かない)。上限をスキップする条件は「この後の上流呼び出しに実際に
  // 利用者キーが使われること」と同一で、サーバー側キーが使われる経路では必ず上限が効く。
  if (userApiKey === undefined) {
    const accountId = c.get('accountId');
    const day = todayUtc();
    const perUserLimit = Number(c.env.AI_DAILY_LIMIT_PER_USER ?? '50');
    const globalLimit = Number(c.env.AI_DAILY_LIMIT_GLOBAL ?? '500');

    // 判定順: 利用者→全体。超過時にカウントが1消費される点は許容(db.tsのコメントに明記)。
    const userCount = await incrementAiUsage(c.env.DB, accountId, day);
    if (userCount > perUserLimit) {
      return c.json(
        {
          error: {
            code: 'ai_limit_exceeded',
            message: '本日の利用回数の上限に達しました。明日また利用できます',
          },
        },
        429
      );
    }

    const globalCount = await incrementAiUsage(c.env.DB, AI_GLOBAL_USAGE_ACCOUNT_ID, day);
    if (globalCount > globalLimit) {
      return c.json(
        {
          error: {
            code: 'ai_global_limit_exceeded',
            message: '本日の利用回数の上限に達しました。明日また利用できます',
          },
        },
        429
      );
    }
  }

  const result = await callAi(c.env, validation.messages, validation.system, userApiKey);
  if (!result.ok) {
    return c.json(
      { error: { code: result.error.code, message: result.error.message } },
      result.error.status as 400 | 429 | 500 | 502 | 503
    );
  }

  return c.json({
    text: result.value.text,
    stopReason: result.value.stopReason,
    usage: result.value.usage,
  });
});

app.get('/api/ai/quota', requireAuth, async (c) => {
  const accountId = c.get('accountId');
  const day = todayUtc();
  const limit = Number(c.env.AI_DAILY_LIMIT_PER_USER ?? '50');
  const used = await getAiUsageCount(c.env.DB, accountId, day);
  return c.json({ used, limit });
});

export default app;
