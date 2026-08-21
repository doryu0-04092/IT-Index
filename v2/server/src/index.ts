import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import { validatePassword } from '@it-index/shared';
import { hashPassword, verifyPassword } from './crypto';
import { issueToken, requireAuth, type AuthedVariables } from './auth';
import {
  AI_GLOBAL_USAGE_ACCOUNT_ID,
  aiTestUsageAccountId,
  deleteKeyShare,
  deleteSyncBlobs,
  getAiUsageCount,
  incrementAiUsage,
  insertSyncBlob,
  isUniqueConstraintError,
  pullSyncBlobs,
  putKeyShare,
  takeKeyShare,
  todayUtc,
} from './db';
import { callAi, runConnectionTest, validateChatRequest, validateTestRequest } from './ai';
import { listAnthropicModels } from './providers/anthropic';
import { listOpenAiModels } from './providers/openai';
import {
  LICENSE_DAILY_ATTEMPT_LIMIT,
  activateExistingLicense,
  cancelActiveLicense,
  findActiveLicenseForAccount,
  findLicenseByCode,
  hasActiveLicense,
  insertOperatorLicense,
  isLicenseEnabled,
  issuePurchasedLicense,
  licenseUsageAccountId,
  matchesOperatorCode,
  validateCodeInput,
} from './license';
import {
  deletePaymentMethod,
  getPaymentMethod,
  upsertPaymentMethod,
  validatePaymentMethodInput,
} from './paymentMethod';

const MAX_PAYLOAD_BYTES = 1024 * 1024;

const app = new Hono<{ Bindings: Env; Variables: AuthedVariables }>();

type AppContext = Context<{ Bindings: Env; Variables: AuthedVariables }>;

/**
 * ライセンスゲート(requirements.md §4 / architecture.md §4・§5)。
 * 公式ホストでは端末間同期と運営者キーでのAI利用を、有効なライセンスを持つアカウントに限る。
 *
 * **置き場所がここ(ルートハンドラ側)である理由**: ai.tsのresolveCallProviderは
 * 「利用者キーが有るか無いか」だけを判定し、それが上限スキップの唯一の条件という既存の
 * 不変条件を担っている。公式ホスト限定の追加条件をあの関数へ混ぜないため、ai.tsは触らない。
 *
 * LICENSE_ENABLED='0'(セルフホスト)では確認自体を行わない。
 * 通してよい場合はundefinedを返す(呼び出し側は戻り値があればそれを返す)。
 */
async function licenseDenial(c: AppContext): Promise<Response | undefined> {
  if (!isLicenseEnabled(c.env)) return undefined;
  if (await hasActiveLicense(c.env.DB, c.get('accountId'))) return undefined;
  return c.json(
    {
      error: {
        code: 'license_required',
        message:
          '同期と共有AIの利用にはライセンスが必要です。設定画面から購入(モック)するか、自分のサーバーを設定してください。',
      },
    },
    403
  );
}

/**
 * ライセンス操作(購入・有効化)の日次試行上限。ai_usageの予約キー方式(license.ts)で数える。
 * 上限に達したら429。上限判定はコード照合より前に置く(総当たりの試行そのものを数えるため)。
 */
async function licenseAttemptDenial(c: AppContext): Promise<Response | undefined> {
  const attempts = await incrementAiUsage(
    c.env.DB,
    licenseUsageAccountId(c.get('accountId')),
    todayUtc()
  );
  if (attempts <= LICENSE_DAILY_ATTEMPT_LIMIT) return undefined;
  return c.json(
    {
      error: {
        code: 'license_attempts_exceeded',
        message: 'ライセンス操作の回数が本日の上限に達しました。明日また試せます',
      },
    },
    429
  );
}

/**
 * 接続確認系(POST /api/ai/test・POST /api/ai/models)の日次回数上限。
 * どちらも「利用者キーで上流を1回叩いて確かめる」操作で、費用は本人負担のためチャットの
 * 残量(ai_usage の accountId 行)は消費しない。ただし認証済みアカウントを踏み台に上流を
 * 叩かれないよう、テスト専用の予約キー(db.ts aiTestUsageAccountId)の**同じ1枠**で数える
 * ——モデル一覧の取得は疎通確認そのもの(キーが無効なら401で分かる)であり、別枠を増やすと
 * 「一覧取得なら何回でも叩ける」抜け道になる。
 */
async function aiConnectionAttemptDenial(c: AppContext): Promise<Response | undefined> {
  const testLimit = Number(c.env.AI_TEST_DAILY_LIMIT ?? '20');
  const testCount = await incrementAiUsage(
    c.env.DB,
    aiTestUsageAccountId(c.get('accountId')),
    todayUtc()
  );
  if (testCount <= testLimit) return undefined;
  return c.json(
    {
      error: {
        code: 'ai_test_limit_exceeded',
        message: '接続テストの回数が本日の上限に達しました。明日また試せます',
      },
    },
    429
  );
}

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
  // 保存は小文字に正規化する(#213)。引く側はCOLLATE NOCASEで吸収するので必須ではないが、
  // 表記を1つに寄せておくと「保存された形」を意識せずに済む。パスワードは正規化しない。
  const email = body?.email?.trim().toLowerCase();
  const password = body?.password;

  if (!email || !password) {
    return c.json({ error: { code: 'invalid_request', message: 'emailとpasswordが必要です' } }, 400);
  }
  // パスワード要件(#205)。判定はshared/core/passwordPolicyの1箇所に置き、画面側と同じ関数を使う。
  // 画面の検証はUXのための先出しで、ここを通らなければ登録されない(このエンドポイントを
  // 直接叩けば画面は迂回できるため、防御の本体はこちら)。
  // **ログイン(/api/auth/login)では検証しない**——再設定の導線が無いため、条件に該当する
  // 既存アカウントが永久にログイン不能になる。
  const policy = validatePassword(password);
  if (!policy.ok) {
    // エラーコードは 'weak_password' のまま据え置き(既存の契約)。理由はmessageで返す
    return c.json({ error: { code: 'weak_password', message: policy.message } }, 400);
  }

  // 重複判定もログインと同じ基準にする(#213)。ここを区別すると大文字違いの二重登録ができてしまい、
  // その後どちらでログインしても引けるのは片方だけ、という状態になる。
  const existing = await c.env.DB.prepare('SELECT id FROM accounts WHERE email = ?1 COLLATE NOCASE')
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

  // メールの大文字小文字は区別しない(#213)。スマートフォンのキーボードは先頭を大文字にすることがあり、
  // 区別すると「PCでは入れるのに端末では弾かれる」状態になる。既存の行の保存形に関わらず引けるよう
  // 照合順序で吸収する(lower()で包むとUNIQUE索引が使えなくなるため COLLATE NOCASE を使う)。
  const account = await c.env.DB.prepare('SELECT id, password_hash FROM accounts WHERE email = ?1 COLLATE NOCASE')
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
  // licensedは「このアカウントで同期・共有AIを使える状態か」を表す。
  // LICENSE_ENABLED='0'(セルフホスト)ではライセンス概念が無いため常にtrueになり、
  // クライアントはこの1つの値だけで購入導線の出し分けを決められる
  // (=ゲートの判定条件とクライアントの表示条件が食い違わない)。
  const license = await findActiveLicenseForAccount(c.env.DB, accountId);
  const licensed = !isLicenseEnabled(c.env) || license !== null;

  // 設定画面の「ライセンス」欄が表示に使う。元は端末のlocalStorageに持っていたが、
  // 購入した端末以外で「ライセンス有効なのにカード未登録」という矛盾表示になっていたため、
  // ライセンスと同じくアカウント単位のデータとしてサーバーから返す(migrations/0004)。
  // codeを載せるのは認証済み本人の自分のコードだけ(license.ts冒頭コメントの例外に当たる)。
  const paymentMethod = await getPaymentMethod(c.env.DB, accountId);
  return c.json({
    accountId: account.id,
    email: account.email,
    licensed,
    licenseCode: license?.code ?? null,
    licenseSource: license?.source ?? null,
    activatedAt: license?.activated_at ?? null,
    paymentMethod,
  });
});

/**
 * お支払い方法(表示情報)の登録・変更。**有効なライセンスを持つアカウントだけ**が呼べる——
 * ライセンスと無関係なカードを登録できると、設定画面が「引き落とされているカード」として
 * 実態のないカードを表示してしまうため(この不整合が元の不具合の一部)。
 *
 * 受け取るのは表示用の4項目のみ。完全なカード番号・CVCは送られてこないし、保存もしない。
 */
app.put('/api/payment-method', requireAuth, async (c) => {
  const accountId = c.get('accountId');
  const body = await c.req.json<unknown>().catch(() => null);
  const validation = validatePaymentMethodInput(body);
  if (!validation.ok) {
    return c.json({ error: { code: 'invalid_request', message: validation.error } }, 400);
  }

  if (isLicenseEnabled(c.env) && !(await hasActiveLicense(c.env.DB, accountId))) {
    return c.json(
      {
        error: {
          code: 'license_required',
          message: 'お支払い方法の登録にはライセンスが必要です',
        },
      },
      403
    );
  }

  await upsertPaymentMethod(c.env.DB, accountId, validation.method, Date.now());
  return c.json({ paymentMethod: validation.method });
});

/**
 * 解約(即時無効)。ライセンスにcanceled_atを立て、同時に登録カードも削除する——
 * 解約後は「引き落とされるカード」が存在しないため、残すと表示が実態とずれる。
 *
 * **日次試行上限(licenseAttemptDenial)はかけない**: 解約を回数制限で妨げる作りは
 * 製品として不適切なため。購入・有効化の総当たり対策とは目的が違う。
 */
app.post('/api/license/cancel', requireAuth, async (c) => {
  const accountId = c.get('accountId');
  const canceled = await cancelActiveLicense(c.env.DB, accountId, Date.now());
  if (!canceled) {
    return c.json(
      {
        error: {
          code: 'license_not_active',
          message: '解約できる有効なライセンスがありません',
        },
      },
      409
    );
  }
  await deletePaymentMethod(c.env.DB, accountId);
  return c.json({ canceled: true });
});

/**
 * 決済モック(requirements.md §4.2)。実際の課金は行わず、サーバーがコードを発行して
 * そのアカウントで即時有効化する。応答のcodeは「決済が確定されました。ライセンスコード: …」を
 * クライアントが表示するためのもので、**本人の購入応答にコードを載せるのは仕様**。
 */
app.post('/api/license/purchase', requireAuth, async (c) => {
  const accountId = c.get('accountId');

  // 既に有効なライセンスがあるなら発行しない(重複購入の誤操作防止。実課金でないため機会損失なし)。
  // この判定は書き込みを伴わないため試行上限より前に置く——購入済みの利用者が画面の再読み込みで
  // 日次の試行枠を使い切らないようにするため。
  if (await hasActiveLicense(c.env.DB, accountId)) {
    return c.json(
      {
        error: {
          code: 'license_already_active',
          message: 'このアカウントには既に有効なライセンスがあります',
        },
      },
      409
    );
  }

  const attemptDenied = await licenseAttemptDenial(c);
  if (attemptDenied) return attemptDenied;

  const { code, activatedAt } = await issuePurchasedLicense(c.env.DB, accountId, Date.now());
  return c.json({ code, activatedAt }, 201);
});

/**
 * ライセンスコードの有効化。有効化できるのは
 * (a) 運営者コード(環境変数LICENSE_CODES。初回使用時にsource='operator'の行を作る)
 * (b) licensesテーブルに存在する未有効化のコード(発行済み在庫)
 * のいずれか。1コード=1アカウントで、2回目以降の同一コードは(b)の経路で使用済みになる。
 *
 * **エラー応答はコード値も部分一致情報も返さない**。存在しないコードと他人が使用済みの
 * コードは同じ403・同じmessageにしてある(区別すると「そのコードは存在する」という
 * 総当たりのヒントになるため)。本人が自分の有効化済みコードを再送した場合だけ200で冪等。
 */
app.post('/api/license/activate', requireAuth, async (c) => {
  const body = await c.req.json<{ code?: unknown }>().catch(() => null);
  const validation = validateCodeInput(body?.code);
  if (!validation.ok) {
    return c.json({ error: { code: 'invalid_request', message: validation.error } }, 400);
  }

  const accountId = c.get('accountId');
  const invalidCode = () =>
    c.json(
      {
        error: {
          code: 'license_invalid',
          message: 'ライセンスコードが正しくありません。入力内容を確認してください',
        },
      },
      403
    );

  // 上限判定はコード照合より前。成否に関わらず1回消費する(失敗だけ数える方式では
  // 当たりを引くまでの試行回数に上限がかからない)。
  const attemptDenied = await licenseAttemptDenial(c);
  if (attemptDenied) return attemptDenied;

  const code = validation.code;
  const now = Date.now();
  const existing = await findLicenseByCode(c.env.DB, code);

  if (existing === null) {
    // 未登録のコード。運営者コードの初回使用ならここで行を作って有効化する。
    if (await matchesOperatorCode(c.env, code)) {
      const inserted = await insertOperatorLicense(c.env.DB, code, accountId, now);
      if (inserted) return c.json({ activatedAt: now });
      // 同時実行で他アカウントが先に使った場合。使用済みと同じ扱いにする。
    }
    return invalidCode();
  }

  if (existing.activated_at !== null) {
    // 解約済みのコードは本人が送っても復活しない(1コード=1回。再開は新規購入)。
    // ここを冪等の200に含めると、ライセンスは無効なのに成功表示になる。
    if (existing.canceled_at !== null) return invalidCode();
    if (existing.account_id === accountId) {
      // 本人による再送。リトライ安全のため冪等に200(activated_atは最初の値のまま)。
      return c.json({ activatedAt: existing.activated_at });
    }
    return invalidCode();
  }

  const activated = await activateExistingLicense(c.env.DB, code, accountId, now);
  if (!activated) return invalidCode();
  return c.json({ activatedAt: now });
});

app.post('/api/sync/push', requireAuth, async (c) => {
  // ゲート順: 認証(requireAuth)→ライセンス→本文の検証・保存。
  // 未ライセンスならpayloadを読む前に返す(D1への書き込みも発生しない)。
  const licenseDenied = await licenseDenial(c);
  if (licenseDenied) return licenseDenied;

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
  const licenseDenied = await licenseDenial(c);
  if (licenseDenied) return licenseDenied;

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

/**
 * 鍵の受け渡し(#182)。端末が持つデータ鍵(DK)を、8桁の受け渡しコードで包んだ状態で
 * 5分だけ預かる。**サーバーが受け取るのは暗号文とsaltだけ**で、DKもコードも渡らない
 * (包む・開くはクライアント側のshared/core/syncCrypto.tsで完結する)。
 *
 * ゲート順は同期と同じ 認証→ライセンス→本文。鍵の受け渡しは同期のための機能なので、
 * 同期が使えないアカウントに預け先を提供しない。
 */
app.put('/api/sync/keyshare', requireAuth, async (c) => {
  const licenseDenied = await licenseDenial(c);
  if (licenseDenied) return licenseDenied;

  const body = await c.req.json<{ salt?: string; wrappedDk?: string }>().catch(() => null);
  const salt = body?.salt;
  const wrappedDk = body?.wrappedDk;
  if (typeof salt !== 'string' || typeof wrappedDk !== 'string' || salt === '' || wrappedDk === '') {
    return c.json(
      { error: { code: 'invalid_request', message: 'saltとwrappedDkが必要です' } },
      400
    );
  }
  // 包んだ鍵は数百バイト程度にしかならない。想定外に大きな値を預けさせない
  if (salt.length > 256 || wrappedDk.length > 4096) {
    return c.json({ error: { code: 'invalid_request', message: '値が大きすぎます' } }, 400);
  }

  const accountId = c.get('accountId');
  const { expiresAt } = await putKeyShare(c.env.DB, accountId, salt, wrappedDk, Date.now());
  return c.json({ expiresAt }, 201);
});

/**
 * 預かっている鍵を取り出す。取り出すたびに回数を数え、上限(5回)超過・期限切れでは
 * 行ごと破棄して404を返す。**「無い」と「使い切った」を区別しない**——当てずっぽうの
 * 試行に手がかりを与えないため。
 */
app.get('/api/sync/keyshare', requireAuth, async (c) => {
  const licenseDenied = await licenseDenial(c);
  if (licenseDenied) return licenseDenied;

  const accountId = c.get('accountId');
  const row = await takeKeyShare(c.env.DB, accountId, Date.now());
  if (!row) {
    return c.json(
      {
        error: {
          code: 'keyshare_not_found',
          message: '受け渡しの有効期限が切れているか、まだ準備されていません',
        },
      },
      404
    );
  }
  return c.json({ salt: row.salt, wrappedDk: row.wrapped_dk });
});

/** 受け取りに成功した側が消す。取り残しは期限切れで失効する(二段で残さない) */
app.delete('/api/sync/keyshare', requireAuth, async (c) => {
  const licenseDenied = await licenseDenial(c);
  if (licenseDenied) return licenseDenied;

  await deleteKeyShare(c.env.DB, c.get('accountId'));
  return c.json({ deleted: true });
});

/**
 * 自アカウントの同期差分をすべて消す(#182)。暗号化への切り替え・鍵の作り直しで使う。
 * 各行は端末の全量スナップショットなので、消しても情報は失われない(次のpushで作り直される)。
 *
 * 消した後はseqが1から振り直しになるため、cursorが残った端末は何もpullしなくなる。
 * これはクライアント側の自己修復(latest < cursor でcursorを0へ戻す)で解消する
 * (client/src/sync/syncEngine.ts)。
 */
app.delete('/api/sync/blobs', requireAuth, async (c) => {
  const licenseDenied = await licenseDenial(c);
  if (licenseDenied) return licenseDenied;

  const deleted = await deleteSyncBlobs(c.env.DB, c.get('accountId'));
  return c.json({ deleted });
});

app.post('/api/ai/chat', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  const validation = validateChatRequest(body);
  if (!validation.ok) {
    return c.json({ error: { code: 'invalid_request', message: validation.error } }, 400);
  }

  // 利用者持ち込みキー(BYOK)はプロバイダをリクエストごとに選べる(docs/v2/architecture.md §5)。
  // apiProviderが指定されていればその経路、未指定なら'openai'(ai.ts resolveCallProvider)。
  // サーバー運用のAI_PROVIDERは見ない——利用者キーが付いたリクエストがサーバー側キーへ
  // 落ちる経路を作らないことで、「キーを付ければ上限だけ回避できる」抜け道を塞ぐ。
  const userApiKey = validation.userApiKey;

  // 利用者が自分のキーを使う場合は費用が本人負担のため、回数上限の判定もカウントも行わない
  // (ai_usageに一切書かない)。上限をスキップする条件は「この後の上流呼び出しに実際に
  // 利用者キーが使われること」と同一で、サーバー側キーが使われる経路では必ず上限が効く。
  if (userApiKey === undefined) {
    // 運営者キー経路。公式ホストでは有効なライセンスを持つアカウントに限る
    // (architecture.md §5の不変条件)。ゲート順は 認証→ライセンス→上限 で、
    // incrementAiUsageより前に403を返すため、**未ライセンスのリクエストは
    // 利用者・全体いずれの残量も消費しない**。
    // 判定条件はこの`userApiKey === undefined`(=上限が効く条件、=上流を運営者キーで
    // 呼ぶ条件)と同一で、ライセンス判定を別に組み直していない。
    const licenseDenied = await licenseDenial(c);
    if (licenseDenied) return licenseDenied;

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

  const result = await callAi(c.env, validation.messages, validation.system, {
    userApiKey,
    apiProvider: validation.apiProvider,
    model: validation.model,
  });
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

/**
 * 利用者が持ち込むキーの接続テスト(docs/v2/architecture.md §5、要件定義書§5.7)。
 * 上流へ最小のリクエストを1件だけ投げ、成功すればプロバイダ・モデル・usageを返す。
 * 失敗は理由ごとの日本語messageで返す(キーの値は応答にもログにも一切出さない)。
 *
 * チャットの回数上限(ai_usage の accountId 行)は消費しない: 上流を呼ぶのは利用者自身の
 * キーであり、費用は本人負担のため。ただし認証済みアカウントを踏み台に上流を叩かれないよう、
 * テスト専用の別枠(db.ts aiTestUsageAccountId)で日次回数を数える。
 */
app.post('/api/ai/test', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  const validation = validateTestRequest(body);
  if (!validation.ok) {
    return c.json({ error: { code: 'invalid_request', message: validation.error } }, 400);
  }

  const attemptDenied = await aiConnectionAttemptDenial(c);
  if (attemptDenied) return attemptDenied;

  const result = await runConnectionTest(c.env, {
    apiKey: validation.apiKey,
    apiProvider: validation.apiProvider,
    model: validation.model,
  });
  if (!result.ok) {
    return c.json(
      { error: { code: result.error.code, message: result.error.message } },
      result.error.status as 400 | 429 | 500 | 502 | 503
    );
  }

  return c.json({ ok: true, provider: result.provider, model: result.model, usage: result.usage });
});

/**
 * 利用者キーで選べるモデルの一覧(v1 src/ai/providers/index.ts listModelsForProvider の移植)。
 * 設定画面はモデル名を自由入力させず、この一覧から選ばせる(誤ったモデル名を打ち込めないように
 * するため)。**一覧の取得自体が接続確認を兼ねる**ので、クライアントの「接続テスト」はこれを呼ぶ。
 *
 * 認証は必須・ライセンスは不要(利用者キーの経路なので費用は本人負担。/api/ai/testと同じ扱い)。
 * 検証はvalidateTestRequestを再利用する——必要な入力(apiKey必須・apiProvider必須)と
 * 文字種チェック(ヘッダ注入を塞ぐAPI_KEY_PATTERN)が接続テストと同一のため、
 * 同じ規則を2箇所に書き分けない。modelは受け取っても使わない(一覧取得に無関係)。
 *
 * 日次回数は接続テストと同じ枠で数える(aiConnectionAttemptDenial)。
 * 応答・エラーにキーの値は一切載せない(providers側で固定文言のみ返す)。
 */
app.post('/api/ai/models', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  const validation = validateTestRequest(body);
  if (!validation.ok) {
    return c.json({ error: { code: 'invalid_request', message: validation.error } }, 400);
  }

  const attemptDenied = await aiConnectionAttemptDenial(c);
  if (attemptDenied) return attemptDenied;

  // 呼び先の2分岐だけをここに置く(ai.tsのresolveCallProvider——「上限スキップの条件=利用者
  // キーで上流を呼ぶ条件」という不変条件を担う関数——には手を入れない。この経路は常に
  // 利用者キーで、サーバー側キーへ落ちる分岐を持たない)。
  const result =
    validation.apiProvider === 'openai'
      ? await listOpenAiModels(validation.apiKey)
      : await listAnthropicModels(validation.apiKey);
  if (!result.ok) {
    return c.json(
      { error: { code: result.error.code, message: result.error.message } },
      result.error.status as 400 | 429 | 500 | 502 | 503
    );
  }

  return c.json({ provider: validation.apiProvider, models: result.models });
});

app.get('/api/ai/quota', requireAuth, async (c) => {
  const accountId = c.get('accountId');
  const day = todayUtc();
  const limit = Number(c.env.AI_DAILY_LIMIT_PER_USER ?? '50');
  const used = await getAiUsageCount(c.env.DB, accountId, day);
  return c.json({ used, limit });
});

export default app;
