import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BASE,
  authHeaders,
  installFetchMock,
  issueUnactivatedLicense,
  signupAccount,
} from './helpers';

// ライセンス基盤(requirements.md §4 / architecture.md §4・§5)の検証。
// 公式ホストでは同期と運営者キーのAI利用に有効なライセンスを要求し、
// BYOK・接続テストは要求しない。セルフホストはLICENSE_ENABLED='0'で全ゲートが止まる。

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

let activeMock: ReturnType<typeof installFetchMock> | undefined;

afterEach(() => {
  activeMock?.restore();
  activeMock = undefined;
  env.LICENSE_ENABLED = undefined;
  env.LICENSE_CODES = undefined;
});

/** 上流を呼んだら必ずここに記録される。呼ばれてはいけないテストでは calls.length を見る */
function mockUpstream(payload: unknown) {
  activeMock = installFetchMock(
    () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
  );
  return activeMock;
}

function openAiOk() {
  return mockUpstream({
    choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
}

function anthropicOk() {
  return mockUpstream({
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

const today = () => new Date().toISOString().slice(0, 10);

async function usageCount(usageKey: string): Promise<number> {
  const row = await env.DB.prepare('SELECT count FROM ai_usage WHERE account_id = ?1 AND day = ?2')
    .bind(usageKey, today())
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function syncBlobCount(accountId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM sync_blobs WHERE account_id = ?1'
  )
    .bind(accountId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function push(token: string) {
  return exports.default.fetch(`${BASE}/api/sync/push`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ deviceId: 'device-a', payload: '{}' }),
  });
}

async function pull(token: string) {
  return exports.default.fetch(`${BASE}/api/sync/pull?since=0`, { headers: authHeaders(token) });
}

async function chat(token: string, extra: Record<string, unknown> = {}) {
  return exports.default.fetch(`${BASE}/api/ai/chat`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], ...extra }),
  });
}

async function connectionTest(token: string) {
  return exports.default.fetch(`${BASE}/api/ai/test`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ apiKey: 'sk-user-key', apiProvider: 'anthropic' }),
  });
}

async function modelList(token: string) {
  return exports.default.fetch(`${BASE}/api/ai/models`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ apiKey: 'sk-user-key', apiProvider: 'anthropic' }),
  });
}

async function me(token: string) {
  return exports.default.fetch(`${BASE}/api/auth/me`, { headers: authHeaders(token) });
}

async function purchase(token: string) {
  return exports.default.fetch(`${BASE}/api/license/purchase`, {
    method: 'POST',
    headers: authHeaders(token),
  });
}

async function activate(token: string, body: unknown) {
  return exports.default.fetch(`${BASE}/api/license/activate`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
}

async function cancel(token: string) {
  return exports.default.fetch(`${BASE}/api/license/cancel`, {
    method: 'POST',
    headers: authHeaders(token),
  });
}

describe('ライセンスゲート(未ライセンス)', () => {
  it('sync/pushは403 license_required。blobもai_usageも増えない', async () => {
    const account = await signupAccount('gate', { license: false });
    const mock = mockUpstream({});

    const res = await push(account.token);
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('license_required');
    expect(body.error.message).toContain('ライセンスが必要です');

    expect(mock.calls).toHaveLength(0);
    expect(await syncBlobCount(account.accountId)).toBe(0);
    expect(await usageCount(account.accountId)).toBe(0);
  });

  it('sync/pullは403 license_required。上流呼び出しもai_usageも発生しない', async () => {
    const account = await signupAccount('gate', { license: false });
    const mock = mockUpstream({});

    const res = await pull(account.token);
    expect(res.status).toBe(403);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe('license_required');
    expect(mock.calls).toHaveLength(0);
    expect(await usageCount(account.accountId)).toBe(0);
  });

  it('運営者キーのチャットは403で、上限カウントを消費しない', async () => {
    const account = await signupAccount('gate', { license: false });
    const mock = mockUpstream({});
    const globalBefore = await usageCount('__global__');

    const res = await chat(account.token);
    expect(res.status).toBe(403);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe('license_required');

    // 上流は呼ばれず、利用者・全体いずれのカウントも増えない(ゲートはincrementAiUsageより前)。
    expect(mock.calls).toHaveLength(0);
    expect(await usageCount(account.accountId)).toBe(0);
    expect(await usageCount('__global__')).toBe(globalBefore);
  });

  it('BYOK(apiKey付き)のチャットはライセンス不要で200', async () => {
    const account = await signupAccount('gate', { license: false });
    const mock = openAiOk();

    const res = await chat(account.token, { apiKey: 'sk-user-key' });
    expect(res.status).toBe(200);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].url).toBe(OPENAI_URL);
    // 費用が本人負担のため、従来どおりai_usageも増えない。
    expect(await usageCount(account.accountId)).toBe(0);
  });

  it('POST /api/ai/testはライセンス不要で200', async () => {
    const account = await signupAccount('gate', { license: false });
    const mock = anthropicOk();

    const res = await connectionTest(account.token);
    expect(res.status).toBe(200);
    expect(mock.calls[0].url).toBe(ANTHROPIC_URL);
  });

  it('POST /api/ai/modelsはライセンス不要で200(利用者キーの経路)', async () => {
    const account = await signupAccount('gate', { license: false });
    const mock = mockUpstream({ data: [{ id: 'claude-haiku-5' }] });

    const res = await modelList(account.token);
    expect(res.status).toBe(200);
    expect(mock.calls[0].url).toBe('https://api.anthropic.com/v1/models');
  });

  it('GET /api/auth/meはlicensed:falseを返す', async () => {
    const account = await signupAccount('gate', { license: false });
    const body = await (await me(account.token)).json<{ licensed: boolean }>();
    expect(body.licensed).toBe(false);
  });
});

describe('LICENSE_ENABLED=0(セルフホスト)', () => {
  it('未ライセンスでも同期・運営者キーチャットが通り、meはlicensed:true', async () => {
    env.LICENSE_ENABLED = '0';
    const account = await signupAccount('selfhost', { license: false });
    anthropicOk();

    expect((await push(account.token)).status).toBe(201);
    expect((await pull(account.token)).status).toBe(200);
    expect((await chat(account.token)).status).toBe(200);

    const body = await (await me(account.token)).json<{ licensed: boolean }>();
    expect(body.licensed).toBe(true);
  });
});

describe('POST /api/license/purchase(決済モック)', () => {
  it('発行して即時有効化し、codeを返す。同期も解禁される', async () => {
    const account = await signupAccount('purchase', { license: false });

    const res = await purchase(account.token);
    expect(res.status).toBe(201);
    const body = await res.json<{ code: string; activatedAt: number }>();
    // 応答にcodeが含まれるのは仕様(クライアントが利用者へ提示する)。
    expect(body.code).toMatch(/^ITX-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(typeof body.activatedAt).toBe('number');

    const meBody = await (await me(account.token)).json<{ licensed: boolean }>();
    expect(meBody.licensed).toBe(true);
    expect((await push(account.token)).status).toBe(201);

    const row = await env.DB.prepare(
      'SELECT source, account_id, activated_at FROM licenses WHERE code = ?1'
    )
      .bind(body.code)
      .first<{ source: string; account_id: string; activated_at: number }>();
    expect(row).toMatchObject({ source: 'purchase', account_id: account.accountId });
    expect(row?.activated_at).toBe(body.activatedAt);
  });

  it('毎回異なるコードが発行される', async () => {
    const first = await signupAccount('purchase', { license: false });
    const second = await signupAccount('purchase', { license: false });
    const codeA = (await (await purchase(first.token)).json<{ code: string }>()).code;
    const codeB = (await (await purchase(second.token)).json<{ code: string }>()).code;
    expect(codeA).not.toBe(codeB);
  });

  it('既に有効なライセンスがあるアカウントの再購入は409', async () => {
    const account = await signupAccount('purchase', { license: false });
    expect((await purchase(account.token)).status).toBe(201);

    const second = await purchase(account.token);
    expect(second.status).toBe(409);
    expect((await second.json<{ error: { code: string } }>()).error.code).toBe(
      'license_already_active'
    );
  });

  it('認証なしは401', async () => {
    const res = await exports.default.fetch(`${BASE}/api/license/purchase`, { method: 'POST' });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/license/activate', () => {
  it('LICENSE_CODESに一致するコードで有効化できる(source=operator)', async () => {
    env.LICENSE_CODES = 'OP-FIRST-CODE , OP-SECOND-CODE';
    const account = await signupAccount('activate', { license: false });

    const res = await activate(account.token, { code: 'OP-SECOND-CODE' });
    expect(res.status).toBe(200);
    const body = await res.json<{ activatedAt: number }>();
    expect(typeof body.activatedAt).toBe('number');

    const meBody = await (await me(account.token)).json<{ licensed: boolean }>();
    expect(meBody.licensed).toBe(true);
    expect((await push(account.token)).status).toBe(201);

    const row = await env.DB.prepare('SELECT source, account_id FROM licenses WHERE code = ?1')
      .bind('OP-SECOND-CODE')
      .first<{ source: string; account_id: string }>();
    expect(row).toMatchObject({ source: 'operator', account_id: account.accountId });
  });

  it('一致しないコードは403で、応答に入力値や部分一致の情報が出ない', async () => {
    env.LICENSE_CODES = 'OP-REAL-CODE';
    const account = await signupAccount('activate', { license: false });

    const res = await activate(account.token, { code: 'OP-REAL-COD' });
    expect(res.status).toBe(403);
    const raw = await res.text();
    expect(raw).not.toContain('OP-REAL-COD');
    expect(raw).not.toContain('OP-REAL-CODE');
    const body = JSON.parse(raw) as { error: { code: string } };
    expect(body.error.code).toBe('license_invalid');

    expect((await push(account.token)).status).toBe(403);
  });

  it('LICENSE_CODES未設定なら運営者コード経路は存在しない(何を送っても403)', async () => {
    const account = await signupAccount('activate', { license: false });
    const res = await activate(account.token, { code: 'ANY-CODE' });
    expect(res.status).toBe(403);
  });

  it('1コード1アカウント: 他アカウントが使用済みのコードは403(存在しないコードと同じ応答)', async () => {
    env.LICENSE_CODES = 'OP-SHARED-CODE';
    const owner = await signupAccount('activate', { license: false });
    const other = await signupAccount('activate', { license: false });

    expect((await activate(owner.token, { code: 'OP-SHARED-CODE' })).status).toBe(200);

    const used = await activate(other.token, { code: 'OP-SHARED-CODE' });
    const unknown = await activate(other.token, { code: 'OP-UNKNOWN-CODE' });
    expect(used.status).toBe(403);
    expect(unknown.status).toBe(403);
    // 使用済みと未登録が区別できると「そのコードは存在する」というヒントになるため、
    // codeとmessageの両方が完全に一致することを固定する。
    expect(await used.json()).toEqual(await unknown.json());
  });

  it('本人が自分の有効化済みコードを再送すると200で冪等(activated_atは変わらない)', async () => {
    env.LICENSE_CODES = 'OP-IDEMPOTENT-CODE';
    const account = await signupAccount('activate', { license: false });

    const first = await activate(account.token, { code: 'OP-IDEMPOTENT-CODE' });
    expect(first.status).toBe(200);
    const firstAt = (await first.json<{ activatedAt: number }>()).activatedAt;

    const second = await activate(account.token, { code: 'OP-IDEMPOTENT-CODE' });
    expect(second.status).toBe(200);
    expect((await second.json<{ activatedAt: number }>()).activatedAt).toBe(firstAt);
  });

  it('発行済み未有効化コード(在庫)を有効化できる', async () => {
    const account = await signupAccount('activate', { license: false });
    await issueUnactivatedLicense('STOCK-CODE-0001');

    // 有効化前は未ライセンスのまま(発行と有効化が分離されている)。
    expect((await push(account.token)).status).toBe(403);

    const res = await activate(account.token, { code: 'STOCK-CODE-0001' });
    expect(res.status).toBe(200);
    expect((await push(account.token)).status).toBe(201);

    const row = await env.DB.prepare(
      'SELECT account_id, activated_at FROM licenses WHERE code = ?1'
    )
      .bind('STOCK-CODE-0001')
      .first<{ account_id: string; activated_at: number }>();
    expect(row?.account_id).toBe(account.accountId);
    expect(typeof row?.activated_at).toBe('number');
  });

  it('日次の試行上限(10回)を超えると429', async () => {
    const account = await signupAccount('activate', { license: false });

    for (let attempt = 1; attempt <= 10; attempt++) {
      const res = await activate(account.token, { code: `WRONG-CODE-${attempt}` });
      expect(res.status).toBe(403);
    }

    const overLimit = await activate(account.token, { code: 'WRONG-CODE-11' });
    expect(overLimit.status).toBe(429);
    expect((await overLimit.json<{ error: { code: string } }>()).error.code).toBe(
      'license_attempts_exceeded'
    );
    expect(await usageCount(`license:${account.accountId}`)).toBe(11);
  });

  it('codeが空・非文字列は400', async () => {
    const account = await signupAccount('activate', { license: false });
    expect((await activate(account.token, { code: '   ' })).status).toBe(400);
    expect((await activate(account.token, { code: 123 })).status).toBe(400);
    expect((await activate(account.token, {})).status).toBe(400);
  });

  it('認証なしは401', async () => {
    const res = await exports.default.fetch(`${BASE}/api/license/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'OP-ANY' }),
    });
    expect(res.status).toBe(401);
  });
});

// 解約(POST /api/license/cancel)。即時無効で、ライセンスと登録カードが同時に無くなる。
// 表示だけ解約済みになって実権限が残る事故を防ぐため、**ゲートが実際に閉じること**を
// 見るのがここでの主眼。
describe('解約', () => {
  async function putCard(token: string) {
    return exports.default.fetch(`${BASE}/api/payment-method`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: JSON.stringify({ brand: 'visa', last4: '4242', expiry: '12/29', holderName: 'TARO' }),
    });
  }

  it('解約するとsync/pushが403になる(ゲートが実際に閉じる)', async () => {
    const account = await signupAccount('cancel-gate');
    expect((await push(account.token)).status).toBe(201);

    expect((await cancel(account.token)).status).toBe(200);

    const denied = await push(account.token);
    expect(denied.status).toBe(403);
    expect((await denied.json<{ error: { code: string } }>()).error.code).toBe('license_required');
    expect((await pull(account.token)).status).toBe(403);
  });

  it('解約すると/api/auth/meが未ライセンスを返し、登録カードも消える', async () => {
    const account = await signupAccount('cancel-me');
    await putCard(account.token);

    await cancel(account.token);

    const body = await (await me(account.token)).json<{
      licensed: boolean;
      licenseCode: null;
      paymentMethod: null;
    }>();
    expect(body.licensed).toBe(false);
    expect(body.licenseCode).toBeNull();
    expect(body.paymentMethod).toBeNull();

    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM payment_methods WHERE account_id = ?1')
      .bind(account.accountId)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it('二重解約は409(解約できる有効なライセンスが無い)', async () => {
    const account = await signupAccount('cancel-twice');
    expect((await cancel(account.token)).status).toBe(200);

    const second = await cancel(account.token);
    expect(second.status).toBe(409);
    expect((await second.json<{ error: { code: string } }>()).error.code).toBe('license_not_active');
  });

  it('ライセンスを持たないアカウントの解約は409', async () => {
    const account = await signupAccount('cancel-none', { license: false });
    expect((await cancel(account.token)).status).toBe(409);
  });

  it('解約したコードは再有効化できない(1コード=1回。再開は新規購入)', async () => {
    const account = await signupAccount('cancel-reuse', { license: false });
    await issueUnactivatedLicense('CANCEL-REUSE-0001');
    expect((await activate(account.token, { code: 'CANCEL-REUSE-0001' })).status).toBe(200);

    await cancel(account.token);

    const retry = await activate(account.token, { code: 'CANCEL-REUSE-0001' });
    expect(retry.status).toBe(403);
    // 表示上403でも実際にライセンスが戻っていないことまで見る
    expect((await me(account.token)).status).toBe(200);
    expect((await (await me(account.token)).json<{ licensed: boolean }>()).licensed).toBe(false);
  });

  it('解約後に再購入すると別のコードが発行される', async () => {
    const account = await signupAccount('cancel-repurchase', { license: false });
    const first = await purchase(account.token);
    const firstCode = (await first.json<{ code: string }>()).code;

    await cancel(account.token);

    const second = await purchase(account.token);
    expect(second.status).toBe(201);
    const secondCode = (await second.json<{ code: string }>()).code;
    expect(secondCode).not.toBe(firstCode);
    expect((await (await me(account.token)).json<{ licenseCode: string }>()).licenseCode).toBe(secondCode);
  });

  it('解約は日次の試行上限を消費しない(解約を回数制限で妨げない)', async () => {
    const account = await signupAccount('cancel-nolimit');
    const before = await usageCount(`license:${account.accountId}`);

    await cancel(account.token);

    expect(await usageCount(`license:${account.accountId}`)).toBe(before);
  });

  it('認証なしは401', async () => {
    const res = await exports.default.fetch(`${BASE}/api/license/cancel`, { method: 'POST' });
    expect(res.status).toBe(401);
  });
});
