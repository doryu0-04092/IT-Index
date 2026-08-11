import { exports, env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';

const BASE = 'https://example.com';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

// このvitest-pool-workersのバージョン(0.20.3)には`cloudflare:test`の
// `fetchMock`(undici MockAgent)が存在しない(型定義・ランタイムいずれにも無し。
// 依存追加/更新は禁止のため、globalThis.fetchを直接差し替える方式で代替する)。
type FetchCall = { url: string; init: RequestInit };

function installFetchMock(handler: (url: string, init: RequestInit) => Response) {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const resolvedInit = init ?? {};
    calls.push({ url, init: resolvedInit });
    return handler(url, resolvedInit);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function anthropicSuccessResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function openAiSuccessResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

let activeMock: ReturnType<typeof installFetchMock> | undefined;

afterEach(() => {
  activeMock?.restore();
  activeMock = undefined;
});

function mockAnthropicOnce(handler: (url: string, init: RequestInit) => Response) {
  activeMock = installFetchMock(handler);
  return activeMock;
}

async function signupAndGetToken(): Promise<string> {
  const email = `ai-${crypto.randomUUID()}@example.com`;
  const res = await exports.default.fetch(`${BASE}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123' }),
  });
  const body = await res.json<{ token: string }>();
  return body.token;
}

function authHeaders(token: string) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function chat(token: string, requestBody: unknown) {
  return exports.default.fetch(`${BASE}/api/ai/chat`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(requestBody),
  });
}

async function quota(token: string) {
  return exports.default.fetch(`${BASE}/api/ai/quota`, {
    headers: authHeaders(token),
  });
}

async function todayGlobalUsageCount(): Promise<number> {
  const row = await env.DB.prepare('SELECT count FROM ai_usage WHERE account_id = ?1 AND day = ?2')
    .bind('__global__', new Date().toISOString().slice(0, 10))
    .first<{ count: number }>();
  return row?.count ?? 0;
}

describe('POST /api/ai/chat', () => {
  it('認証なしは401', async () => {
    const res = await chat('not-a-real-token', { messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(401);
  });

  it('正常系: 転送ボディが契約通りで、text blockを連結し、usageを返す', async () => {
    const mock = mockAnthropicOnce((url) => {
      expect(url).toBe(ANTHROPIC_URL);
      return anthropicSuccessResponse({
        content: [{ type: 'text', text: 'Hello there' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 4 },
      });
    });

    const token = await signupAndGetToken();
    const res = await chat(token, {
      messages: [{ role: 'user', content: 'hi' }],
      system: 'be nice',
    });

    expect(res.status).toBe(200);
    const responseBody = await res.json<{
      text: string;
      stopReason: string;
      usage: { inputTokens: number; outputTokens: number };
    }>();
    expect(responseBody.text).toBe('Hello there');
    expect(responseBody.stopReason).toBe('end_turn');
    expect(responseBody.usage).toEqual({ inputTokens: 12, outputTokens: 4 });

    expect(mock.calls).toHaveLength(1);
    const sentHeaders = mock.calls[0].init.headers as Record<string, string>;
    expect(sentHeaders['x-api-key']).toBe(env.ANTHROPIC_API_KEY);
    expect(sentHeaders['anthropic-version']).toBe('2023-06-01');

    const sentBody = JSON.parse(mock.calls[0].init.body as string) as Record<string, unknown>;
    expect(sentBody.model).toBeTypeOf('string');
    expect(sentBody.max_tokens).toBeTypeOf('number');
    expect(sentBody.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(sentBody.system).toBe('be nice');
    // 禁止パラメータが一切送られていないこと
    expect(sentBody.temperature).toBeUndefined();
    expect(sentBody.top_p).toBeUndefined();
    expect(sentBody.top_k).toBeUndefined();
    expect(sentBody.thinking).toBeUndefined();
  });

  it('thinking blockが先頭にある応答でもtextが正しく連結される', async () => {
    mockAnthropicOnce(() =>
      anthropicSuccessResponse({
        content: [
          { type: 'thinking', thinking: '内部の思考...' },
          { type: 'text', text: '最終的な回答' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 6 },
      })
    );

    const token = await signupAndGetToken();
    const res = await chat(token, { messages: [{ role: 'user', content: 'hi' }] });

    expect(res.status).toBe(200);
    const body = await res.json<{ text: string }>();
    expect(body.text).toBe('最終的な回答');
  });

  it('stop_reason=refusalは成功扱いで返す(textが空でもよい)', async () => {
    mockAnthropicOnce(() =>
      anthropicSuccessResponse({
        content: [],
        stop_reason: 'refusal',
        usage: { input_tokens: 5, output_tokens: 0 },
      })
    );

    const token = await signupAndGetToken();
    const res = await chat(token, { messages: [{ role: 'user', content: 'hi' }] });

    expect(res.status).toBe(200);
    const body = await res.json<{ text: string; stopReason: string }>();
    expect(body.stopReason).toBe('refusal');
    expect(body.text).toBe('');
  });

  it('検証エラー: messagesが空配列は400', async () => {
    const token = await signupAndGetToken();
    const res = await chat(token, { messages: [] });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('invalid_request');
  });

  it('検証エラー: roleが不正な場合は400', async () => {
    const token = await signupAndGetToken();
    const res = await chat(token, { messages: [{ role: 'system', content: 'hi' }] });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('invalid_request');
  });

  it('検証エラー: 合計文字数が200,000を超えると400', async () => {
    const token = await signupAndGetToken();
    const res = await chat(token, {
      messages: [{ role: 'user', content: 'a'.repeat(200_001) }],
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('invalid_request');
  });

  it('利用者上限到達で429(上限を小さく設定)', async () => {
    const originalPerUserLimit = env.AI_DAILY_LIMIT_PER_USER;
    env.AI_DAILY_LIMIT_PER_USER = '1';
    try {
      mockAnthropicOnce(() =>
        anthropicSuccessResponse({
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      );

      const token = await signupAndGetToken();
      const first = await chat(token, { messages: [{ role: 'user', content: 'hi' }] });
      expect(first.status).toBe(200);

      // 2回目は上限超過。Anthropicへは転送されない(fetch呼び出し数は1のまま)。
      const second = await chat(token, { messages: [{ role: 'user', content: 'hi' }] });
      expect(second.status).toBe(429);
      const body = await second.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('ai_limit_exceeded');
      expect(activeMock?.calls).toHaveLength(1);
    } finally {
      env.AI_DAILY_LIMIT_PER_USER = originalPerUserLimit;
    }
  });

  it('全体上限到達で429', async () => {
    // 他テストの消費分も含めた「現在の全体カウント」を基準に、次の1件で
    // 超過するよう上限を設定する。利用者側の上限には引っかからないよう緩める。
    const currentGlobalCount = await todayGlobalUsageCount();
    const originalGlobalLimit = env.AI_DAILY_LIMIT_GLOBAL;
    const originalPerUserLimit = env.AI_DAILY_LIMIT_PER_USER;
    env.AI_DAILY_LIMIT_GLOBAL = String(currentGlobalCount);
    env.AI_DAILY_LIMIT_PER_USER = '1000';
    try {
      const token = await signupAndGetToken();
      // 全体上限判定は利用者判定の後なので、Anthropicへの転送は発生しない
      // (このテストではfetchをモックせず、呼ばれたら実ネットワークに出ようとして
      // 失敗することでも検出できる)。
      const res = await chat(token, { messages: [{ role: 'user', content: 'hi' }] });
      expect(res.status).toBe(429);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('ai_global_limit_exceeded');
    } finally {
      env.AI_DAILY_LIMIT_GLOBAL = originalGlobalLimit;
      env.AI_DAILY_LIMIT_PER_USER = originalPerUserLimit;
    }
  });

  it('上流429はそのまま429にマッピングされる', async () => {
    mockAnthropicOnce(
      () =>
        new Response(
          JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } }),
          { status: 429, headers: { 'content-type': 'application/json' } }
        )
    );

    const token = await signupAndGetToken();
    const res = await chat(token, { messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(429);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('ai_upstream_rate_limited');
  });
});

describe('POST /api/ai/chat (AI_PROVIDER=openai)', () => {
  const originalProvider = env.AI_PROVIDER;
  const originalOpenAiKey = env.OPENAI_API_KEY;

  afterEach(() => {
    env.AI_PROVIDER = originalProvider;
    env.OPENAI_API_KEY = originalOpenAiKey;
  });

  it('正常系: 転送ボディが契約通りで、finish_reasonとusageを正規化して返す', async () => {
    env.AI_PROVIDER = 'openai';
    env.OPENAI_API_KEY = 'test-only-openai-key';

    const mock = mockAnthropicOnce((url) => {
      expect(url).toBe(OPENAI_URL);
      return openAiSuccessResponse({
        choices: [{ message: { content: 'Hello there' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 4 },
      });
    });

    const token = await signupAndGetToken();
    const res = await chat(token, {
      messages: [{ role: 'user', content: 'hi' }],
      system: 'be nice',
    });

    expect(res.status).toBe(200);
    const responseBody = await res.json<{
      text: string;
      stopReason: string;
      usage: { inputTokens: number; outputTokens: number };
    }>();
    expect(responseBody.text).toBe('Hello there');
    expect(responseBody.stopReason).toBe('end_turn');
    expect(responseBody.usage).toEqual({ inputTokens: 12, outputTokens: 4 });

    expect(mock.calls).toHaveLength(1);
    const sentHeaders = mock.calls[0].init.headers as Record<string, string>;
    expect(sentHeaders.authorization).toBe(`Bearer ${env.OPENAI_API_KEY}`);

    const sentBody = JSON.parse(mock.calls[0].init.body as string) as Record<string, unknown>;
    expect(sentBody.model).toBeTypeOf('string');
    expect(sentBody.max_completion_tokens).toBeTypeOf('number');
    expect(sentBody.messages).toEqual([
      { role: 'system', content: 'be nice' },
      { role: 'user', content: 'hi' },
    ]);
    // 禁止パラメータが一切送られていないこと(新世代モデルは既定値以外を拒否しうる)。
    expect(sentBody.temperature).toBeUndefined();
    expect(sentBody.top_p).toBeUndefined();
    expect(sentBody.max_tokens).toBeUndefined();
  });

  it('finish_reason=lengthはmax_tokensに正規化される', async () => {
    env.AI_PROVIDER = 'openai';
    env.OPENAI_API_KEY = 'test-only-openai-key';
    mockAnthropicOnce(() =>
      openAiSuccessResponse({
        choices: [{ message: { content: '途中まで' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 5, completion_tokens: 6 },
      })
    );

    const token = await signupAndGetToken();
    const res = await chat(token, { messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    const body = await res.json<{ stopReason: string }>();
    expect(body.stopReason).toBe('max_tokens');
  });

  it('finish_reason=content_filterはrefusalに正規化される', async () => {
    env.AI_PROVIDER = 'openai';
    env.OPENAI_API_KEY = 'test-only-openai-key';
    mockAnthropicOnce(() =>
      openAiSuccessResponse({
        choices: [{ message: { content: null }, finish_reason: 'content_filter' }],
        usage: { prompt_tokens: 5, completion_tokens: 0 },
      })
    );

    const token = await signupAndGetToken();
    const res = await chat(token, { messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    const body = await res.json<{ stopReason: string; text: string }>();
    expect(body.stopReason).toBe('refusal');
    expect(body.text).toBe('');
  });

  it('上流429はそのまま429にマッピングされる', async () => {
    env.AI_PROVIDER = 'openai';
    env.OPENAI_API_KEY = 'test-only-openai-key';
    mockAnthropicOnce(
      () =>
        new Response(
          JSON.stringify({ error: { type: 'insufficient_quota', message: 'quota exceeded' } }),
          { status: 429, headers: { 'content-type': 'application/json' } }
        )
    );

    const token = await signupAndGetToken();
    const res = await chat(token, { messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(429);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('ai_upstream_rate_limited');
  });

  it('OPENAI_API_KEY未設定はai_config_error(500)。上流には転送されない', async () => {
    env.AI_PROVIDER = 'openai';
    env.OPENAI_API_KEY = undefined;
    const mock = installFetchMock(() => {
      throw new Error('fetchが呼ばれるべきではない');
    });
    activeMock = mock;

    const token = await signupAndGetToken();
    const res = await chat(token, { messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('ai_config_error');
    expect(mock.calls).toHaveLength(0);
  });
});

// 利用者持ち込みキー(BYOK)。docs/v2/architecture.md §5「2つのキー経路」。
describe('POST /api/ai/chat (利用者のAPIキー)', () => {
  const originalProvider = env.AI_PROVIDER;
  const originalOpenAiKey = env.OPENAI_API_KEY;
  const originalPerUserLimit = env.AI_DAILY_LIMIT_PER_USER;
  const USER_KEY = 'sk-user-provided-key-for-test';

  afterEach(() => {
    env.AI_PROVIDER = originalProvider;
    env.OPENAI_API_KEY = originalOpenAiKey;
    env.AI_DAILY_LIMIT_PER_USER = originalPerUserLimit;
  });

  const SERVER_KEY = 'test-only-server-openai-key';

  function useOpenAi() {
    env.AI_PROVIDER = 'openai';
    env.OPENAI_API_KEY = SERVER_KEY;
  }

  async function todayUserUsageCount(token: string): Promise<number> {
    const res = await quota(token);
    const body = await res.json<{ used: number }>();
    return body.used;
  }

  it('(a) 上流へは利用者のキーが使われ、サーバー側キーは使われない', async () => {
    useOpenAi();
    const mock = mockAnthropicOnce((url) => {
      expect(url).toBe(OPENAI_URL);
      return openAiSuccessResponse({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    });

    const token = await signupAndGetToken();
    const res = await chat(token, {
      messages: [{ role: 'user', content: 'hi' }],
      apiKey: USER_KEY,
    });

    expect(res.status).toBe(200);
    expect(mock.calls).toHaveLength(1);
    const sentHeaders = mock.calls[0].init.headers as Record<string, string>;
    expect(sentHeaders.authorization).toBe(`Bearer ${USER_KEY}`);
    expect(sentHeaders.authorization).not.toContain(SERVER_KEY);
    // 転送ボディにapiKeyフィールドが混ざらない(上流の契約外フィールドを送らない)
    const sentBody = JSON.parse(mock.calls[0].init.body as string) as Record<string, unknown>;
    expect(sentBody.apiKey).toBeUndefined();
  });

  it('(b) 利用者キー利用時はai_usageが増えない(上限の対象外)', async () => {
    useOpenAi();
    mockAnthropicOnce(() =>
      openAiSuccessResponse({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      })
    );

    const token = await signupAndGetToken();
    const globalBefore = await todayGlobalUsageCount();

    // 上限を0にしても、利用者キーを付けたリクエストは通る(判定自体を行わない)
    env.AI_DAILY_LIMIT_PER_USER = '0';
    const res = await chat(token, {
      messages: [{ role: 'user', content: 'hi' }],
      apiKey: USER_KEY,
    });
    expect(res.status).toBe(200);

    env.AI_DAILY_LIMIT_PER_USER = originalPerUserLimit;
    expect(await todayUserUsageCount(token)).toBe(0);
    expect(await todayGlobalUsageCount()).toBe(globalBefore);
  });

  it('(b2) 空文字のapiKeyは未指定と同じ扱い(サーバー側キー+上限が効く)', async () => {
    useOpenAi();
    const mock = mockAnthropicOnce(() =>
      openAiSuccessResponse({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      })
    );

    const token = await signupAndGetToken();
    const res = await chat(token, { messages: [{ role: 'user', content: 'hi' }], apiKey: '   ' });
    expect(res.status).toBe(200);

    const sentHeaders = mock.calls[0].init.headers as Record<string, string>;
    expect(sentHeaders.authorization).toBe(`Bearer ${SERVER_KEY}`);
    expect(await todayUserUsageCount(token)).toBe(1);
  });

  it('(c) apiKey未指定なら従来どおり利用者上限が効く', async () => {
    useOpenAi();
    env.AI_DAILY_LIMIT_PER_USER = '1';
    mockAnthropicOnce(() =>
      openAiSuccessResponse({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      })
    );

    const token = await signupAndGetToken();
    expect((await chat(token, { messages: [{ role: 'user', content: 'hi' }] })).status).toBe(200);

    const second = await chat(token, { messages: [{ role: 'user', content: 'hi' }] });
    expect(second.status).toBe(429);
    expect((await second.json<{ error: { code: string } }>()).error.code).toBe('ai_limit_exceeded');

    // 同じ上限状態でも、自分のキーを付ければ通る
    const third = await chat(token, {
      messages: [{ role: 'user', content: 'hi' }],
      apiKey: USER_KEY,
    });
    expect(third.status).toBe(200);
  });

  it('(d) apiKeyが長さ上限(200文字)を超えると400。上流には転送されない', async () => {
    useOpenAi();
    const mock = installFetchMock(() => {
      throw new Error('fetchが呼ばれるべきではない');
    });
    activeMock = mock;

    const token = await signupAndGetToken();
    const res = await chat(token, {
      messages: [{ role: 'user', content: 'hi' }],
      apiKey: 'a'.repeat(201),
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe('invalid_request');
    expect(mock.calls).toHaveLength(0);
  });

  it('(d2) apiKeyが文字列以外・制御文字入りは400(ヘッダ注入を塞ぐ)', async () => {
    useOpenAi();
    const mock = installFetchMock(() => {
      throw new Error('fetchが呼ばれるべきではない');
    });
    activeMock = mock;

    const token = await signupAndGetToken();
    const notString = await chat(token, { messages: [{ role: 'user', content: 'hi' }], apiKey: 123 });
    expect(notString.status).toBe(400);

    const withCrlf = await chat(token, {
      messages: [{ role: 'user', content: 'hi' }],
      apiKey: 'sk-abc\r\nx-injected: 1',
    });
    expect(withCrlf.status).toBe(400);
    expect((await withCrlf.json<{ error: { code: string } }>()).error.code).toBe('invalid_request');
    expect(mock.calls).toHaveLength(0);
  });

  it('(e) 利用者キーが上流で401のときは専用コードで返る(ai_config_errorにしない)', async () => {
    useOpenAi();
    mockAnthropicOnce(
      () =>
        new Response(JSON.stringify({ error: { code: 'invalid_api_key' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
    );

    const token = await signupAndGetToken();
    const res = await chat(token, {
      messages: [{ role: 'user', content: 'hi' }],
      apiKey: USER_KEY,
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('user_api_key_invalid');
    expect(body.error.message).toBe('設定したAPIキーが無効です。設定画面で確認してください');
    // 無効キーでもai_usageは消費しない
    expect(await todayUserUsageCount(token)).toBe(0);
  });

  it('(f) 応答・エラーの本文にキーの値が一切含まれない', async () => {
    useOpenAi();
    mockAnthropicOnce(() =>
      openAiSuccessResponse({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      })
    );

    const token = await signupAndGetToken();
    const ok = await chat(token, { messages: [{ role: 'user', content: 'hi' }], apiKey: USER_KEY });
    expect(await ok.text()).not.toContain(USER_KEY);

    activeMock?.restore();
    mockAnthropicOnce(() => new Response('{}', { status: 401 }));
    const failed = await chat(token, {
      messages: [{ role: 'user', content: 'hi' }],
      apiKey: USER_KEY,
    });
    expect(await failed.text()).not.toContain(USER_KEY);

    activeMock?.restore();
    activeMock = installFetchMock(() => {
      throw new Error('fetchが呼ばれるべきではない');
    });
    const tooLong = await chat(token, {
      messages: [{ role: 'user', content: 'hi' }],
      apiKey: `${USER_KEY}${'a'.repeat(200)}`,
    });
    expect(await tooLong.text()).not.toContain(USER_KEY);
  });

  it('Anthropic経路ではBYOKを受け付けず400(上限の抜け道にしない)', async () => {
    env.AI_PROVIDER = 'anthropic';
    const mock = installFetchMock(() => {
      throw new Error('fetchが呼ばれるべきではない');
    });
    activeMock = mock;

    const token = await signupAndGetToken();
    const res = await chat(token, {
      messages: [{ role: 'user', content: 'hi' }],
      apiKey: USER_KEY,
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe(
      'user_api_key_unsupported'
    );
    expect(mock.calls).toHaveLength(0);
    expect(await todayUserUsageCount(token)).toBe(0);
  });

  it('サーバー側キー未設定でも利用者キーがあれば動く', async () => {
    env.AI_PROVIDER = 'openai';
    env.OPENAI_API_KEY = undefined;
    const mock = mockAnthropicOnce(() =>
      openAiSuccessResponse({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      })
    );

    const token = await signupAndGetToken();
    const res = await chat(token, {
      messages: [{ role: 'user', content: 'hi' }],
      apiKey: USER_KEY,
    });
    expect(res.status).toBe(200);
    const sentHeaders = mock.calls[0].init.headers as Record<string, string>;
    expect(sentHeaders.authorization).toBe(`Bearer ${USER_KEY}`);
  });
});

describe('GET /api/ai/quota', () => {
  it('未利用時はused=0、limitは設定値', async () => {
    const token = await signupAndGetToken();
    const res = await quota(token);
    expect(res.status).toBe(200);
    const body = await res.json<{ used: number; limit: number }>();
    expect(body.used).toBe(0);
    expect(body.limit).toBe(Number(env.AI_DAILY_LIMIT_PER_USER));
  });

  it('chat実行後はusedが増える', async () => {
    mockAnthropicOnce(() =>
      anthropicSuccessResponse({
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    );

    const token = await signupAndGetToken();
    const chatRes = await chat(token, { messages: [{ role: 'user', content: 'hi' }] });
    expect(chatRes.status).toBe(200);

    const res = await quota(token);
    const body = await res.json<{ used: number }>();
    expect(body.used).toBe(1);
  });

  it('認証なしは401', async () => {
    const res = await quota('not-a-real-token');
    expect(res.status).toBe(401);
  });
});
