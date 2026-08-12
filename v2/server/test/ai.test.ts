import { exports, env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { BASE, authHeaders, installFetchMock, signupAccount } from './helpers';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

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

// 運営者キー経路のチャットは公式ホストでは要ライセンス(src/license.ts)。ここでは
// プロキシそのものの振る舞いを見たいので、アカウントには既定でライセンスを付与する。
// 未ライセンス時の403・カウント不消費、BYOKと接続テストがライセンス不要であることは
// license.test.tsで検証する。
async function signupAndGetToken(): Promise<string> {
  return (await signupAccount('ai')).token;
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
  const originalModel = env.AI_MODEL;
  const USER_KEY = 'sk-user-provided-key-for-test';

  afterEach(() => {
    env.AI_PROVIDER = originalProvider;
    env.OPENAI_API_KEY = originalOpenAiKey;
    env.AI_DAILY_LIMIT_PER_USER = originalPerUserLimit;
    env.AI_MODEL = originalModel;
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

  it('(g) サーバーがanthropic運用でも、利用者キーはopenai既定で通る(apiProvider未指定=後方互換)', async () => {
    env.AI_PROVIDER = 'anthropic';
    const mock = mockAnthropicOnce((url) => {
      expect(url).toBe(OPENAI_URL);
      return openAiSuccessResponse({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    });

    const token = await signupAndGetToken();
    const res = await chat(token, { messages: [{ role: 'user', content: 'hi' }], apiKey: USER_KEY });
    expect(res.status).toBe(200);
    const sentHeaders = mock.calls[0].init.headers as Record<string, string>;
    expect(sentHeaders.authorization).toBe(`Bearer ${USER_KEY}`);
    expect(await todayUserUsageCount(token)).toBe(0);
  });

  it('(h) apiProvider=anthropicなら、サーバーがopenai運用でもAnthropicを利用者キーで呼ぶ', async () => {
    useOpenAi();
    env.AI_MODEL = 'gpt-5.6-luna';
    const mock = mockAnthropicOnce((url) => {
      expect(url).toBe(ANTHROPIC_URL);
      return anthropicSuccessResponse({
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });

    const token = await signupAndGetToken();
    const res = await chat(token, {
      messages: [{ role: 'user', content: 'hi' }],
      apiKey: USER_KEY,
      apiProvider: 'anthropic',
    });
    expect(res.status).toBe(200);
    const sentHeaders = mock.calls[0].init.headers as Record<string, string>;
    expect(sentHeaders['x-api-key']).toBe(USER_KEY);
    expect(sentHeaders['x-api-key']).not.toBe(env.ANTHROPIC_API_KEY);
    // AI_MODELは運用中プロバイダ(openai)のモデルIDなので、Anthropicへは渡さず既定を使う
    const sentBody = JSON.parse(mock.calls[0].init.body as string) as Record<string, unknown>;
    expect(sentBody.model).toBe('claude-sonnet-5');
    expect(await todayUserUsageCount(token)).toBe(0);
  });

  it('(h2) modelを指定するとそのまま上流へ渡る(利用者キー経路)', async () => {
    useOpenAi();
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
      apiProvider: 'openai',
      model: 'gpt-test-model',
    });
    expect(res.status).toBe(200);
    const sentBody = JSON.parse(mock.calls[0].init.body as string) as Record<string, unknown>;
    expect(sentBody.model).toBe('gpt-test-model');
  });

  // 不変条件: 「上限をスキップする条件」と「利用者キーで上流を呼ぶ条件」は同一。
  // apiKeyを付けたリクエストがサーバー側キーで処理される経路は存在しない。
  it('(i) apiKeyを付けた全ての組み合わせで、上流に使われるのは利用者キーだけ(上限も消費しない)', async () => {
    const cases: Array<{ server: 'openai' | 'anthropic'; requested?: 'openai' | 'anthropic' }> = [
      { server: 'openai', requested: undefined },
      { server: 'openai', requested: 'openai' },
      { server: 'openai', requested: 'anthropic' },
      { server: 'anthropic', requested: undefined },
      { server: 'anthropic', requested: 'openai' },
      { server: 'anthropic', requested: 'anthropic' },
    ];

    for (const testCase of cases) {
      env.AI_PROVIDER = testCase.server;
      env.OPENAI_API_KEY = SERVER_KEY;
      const mock = installFetchMock((url) =>
        url === OPENAI_URL
          ? openAiSuccessResponse({
              choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            })
          : anthropicSuccessResponse({
              content: [{ type: 'text', text: 'ok' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
            })
      );
      activeMock = mock;

      const token = await signupAndGetToken();
      const body: Record<string, unknown> = {
        messages: [{ role: 'user', content: 'hi' }],
        apiKey: USER_KEY,
      };
      if (testCase.requested !== undefined) body.apiProvider = testCase.requested;
      const res = await chat(token, body);
      expect(res.status).toBe(200);

      const sentHeaders = mock.calls[0].init.headers as Record<string, string>;
      const usedKey = sentHeaders.authorization ?? sentHeaders['x-api-key'];
      expect(usedKey).toContain(USER_KEY);
      expect(usedKey).not.toContain(SERVER_KEY);
      expect(usedKey).not.toContain(env.ANTHROPIC_API_KEY);
      expect(await todayUserUsageCount(token)).toBe(0);

      mock.restore();
      activeMock = undefined;
    }
  });

  it('(j) apiProviderが不正値なら400。上流には転送されない', async () => {
    useOpenAi();
    const mock = installFetchMock(() => {
      throw new Error('fetchが呼ばれるべきではない');
    });
    activeMock = mock;

    const token = await signupAndGetToken();
    const res = await chat(token, {
      messages: [{ role: 'user', content: 'hi' }],
      apiKey: USER_KEY,
      apiProvider: 'gemini',
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe('invalid_request');
    expect(mock.calls).toHaveLength(0);
  });

  it('(k) apiKeyなしでapiProvider/modelを指定しても無視され、サーバー運用の設定+上限が効く', async () => {
    useOpenAi();
    env.AI_MODEL = 'gpt-5.6-luna';
    const mock = mockAnthropicOnce((url) => {
      // apiKeyが無いので利用者の選択(anthropic)は採用されず、サーバー運用のopenaiで呼ぶ
      expect(url).toBe(OPENAI_URL);
      return openAiSuccessResponse({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    });

    const token = await signupAndGetToken();
    const res = await chat(token, {
      messages: [{ role: 'user', content: 'hi' }],
      apiProvider: 'anthropic',
      model: 'claude-something-expensive',
    });
    expect(res.status).toBe(200);
    const sentHeaders = mock.calls[0].init.headers as Record<string, string>;
    expect(sentHeaders.authorization).toBe(`Bearer ${SERVER_KEY}`);
    const sentBody = JSON.parse(mock.calls[0].init.body as string) as Record<string, unknown>;
    expect(sentBody.model).toBe('gpt-5.6-luna');
    // サーバー側キーの経路なので上限のカウントは通常どおり進む
    expect(await todayUserUsageCount(token)).toBe(1);
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

// 接続テスト(docs/v2/architecture.md §5、要件定義書§5.7)。
describe('POST /api/ai/test', () => {
  const originalProvider = env.AI_PROVIDER;
  const originalModel = env.AI_MODEL;
  const originalTestLimit = env.AI_TEST_DAILY_LIMIT;
  const USER_KEY = 'sk-test-endpoint-user-key';

  afterEach(() => {
    env.AI_PROVIDER = originalProvider;
    env.AI_MODEL = originalModel;
    env.AI_TEST_DAILY_LIMIT = originalTestLimit;
  });

  async function testConnection(token: string, requestBody: unknown) {
    return exports.default.fetch(`${BASE}/api/ai/test`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(requestBody),
    });
  }

  async function usedCount(token: string): Promise<number> {
    const res = await quota(token);
    return (await res.json<{ used: number }>()).used;
  }

  it('認証なしは401', async () => {
    const res = await testConnection('not-a-real-token', { apiKey: USER_KEY, apiProvider: 'openai' });
    expect(res.status).toBe(401);
  });

  it('成功(openai): 最小のリクエストを1件投げ、provider・model・usageを返す', async () => {
    env.AI_PROVIDER = 'openai';
    env.AI_MODEL = 'gpt-5.6-luna';
    const mock = mockAnthropicOnce((url) => {
      expect(url).toBe(OPENAI_URL);
      return openAiSuccessResponse({
        choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      });
    });

    const token = await signupAndGetToken();
    const globalBefore = await todayGlobalUsageCount();
    const res = await testConnection(token, { apiKey: USER_KEY, apiProvider: 'openai' });

    expect(res.status).toBe(200);
    const body = await res.json<{
      ok: boolean;
      provider: string;
      model: string;
      usage: { inputTokens: number; outputTokens: number };
    }>();
    expect(body).toEqual({
      ok: true,
      provider: 'openai',
      model: 'gpt-5.6-luna',
      usage: { inputTokens: 2, outputTokens: 1 },
    });

    // 上流へは利用者キーで、最小のリクエスト(user1件・生成量も小さく)を投げる
    const sentHeaders = mock.calls[0].init.headers as Record<string, string>;
    expect(sentHeaders.authorization).toBe(`Bearer ${USER_KEY}`);
    const sentBody = JSON.parse(mock.calls[0].init.body as string) as {
      messages: unknown[];
      max_completion_tokens: number;
    };
    expect(sentBody.messages).toHaveLength(1);
    expect(sentBody.max_completion_tokens).toBeLessThanOrEqual(64);

    // 通常のチャット上限(ai_usage の accountId 行・全体行)は消費しない
    expect(await usedCount(token)).toBe(0);
    expect(await todayGlobalUsageCount()).toBe(globalBefore);
  });

  it('成功(anthropic): サーバーがopenai運用でもAnthropicへ利用者キーで投げ、既定モデルを使う', async () => {
    env.AI_PROVIDER = 'openai';
    env.AI_MODEL = 'gpt-5.6-luna';
    const mock = mockAnthropicOnce((url) => {
      expect(url).toBe(ANTHROPIC_URL);
      return anthropicSuccessResponse({
        content: [{ type: 'text', text: 'pong' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 2, output_tokens: 1 },
      });
    });

    const token = await signupAndGetToken();
    const res = await testConnection(token, { apiKey: USER_KEY, apiProvider: 'anthropic' });

    expect(res.status).toBe(200);
    const body = await res.json<{ provider: string; model: string }>();
    expect(body.provider).toBe('anthropic');
    expect(body.model).toBe('claude-sonnet-5');
    const sentHeaders = mock.calls[0].init.headers as Record<string, string>;
    expect(sentHeaders['x-api-key']).toBe(USER_KEY);
  });

  it('modelを指定すればそのモデルでテストし、応答に指定モデル名を返す', async () => {
    env.AI_PROVIDER = 'openai';
    const mock = mockAnthropicOnce(() =>
      openAiSuccessResponse({
        choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      })
    );

    const token = await signupAndGetToken();
    const res = await testConnection(token, {
      apiKey: USER_KEY,
      apiProvider: 'openai',
      model: 'gpt-指定なし',
    });
    // 全角を含むモデル名は文字種検証で弾く
    expect(res.status).toBe(400);
    expect(mock.calls).toHaveLength(0);

    const ok = await testConnection(token, {
      apiKey: USER_KEY,
      apiProvider: 'openai',
      model: 'gpt-4.1-mini',
    });
    expect(ok.status).toBe(200);
    expect((await ok.json<{ model: string }>()).model).toBe('gpt-4.1-mini');
    const sentBody = JSON.parse(mock.calls[0].init.body as string) as Record<string, unknown>;
    expect(sentBody.model).toBe('gpt-4.1-mini');
  });

  it('認証失敗(401)はuser_api_key_invalidで返り、応答にキーの値を含まない', async () => {
    mockAnthropicOnce(() => new Response(JSON.stringify({ error: { code: 'invalid_api_key' } }), { status: 401 }));

    const token = await signupAndGetToken();
    const res = await testConnection(token, { apiKey: USER_KEY, apiProvider: 'openai' });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain(USER_KEY);
    expect(JSON.parse(text).error.code).toBe('user_api_key_invalid');
  });

  it('モデル名が無効(404)ならuser_model_invalidで返る', async () => {
    mockAnthropicOnce(
      () =>
        new Response(
          JSON.stringify({ error: { code: 'model_not_found', message: 'The model does not exist' } }),
          { status: 404 }
        )
    );

    const token = await signupAndGetToken();
    const res = await testConnection(token, {
      apiKey: USER_KEY,
      apiProvider: 'openai',
      model: 'gpt-does-not-exist',
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('user_model_invalid');
    expect(body.error.message).toContain('モデル名');
  });

  it('上流429はai_upstream_rate_limitedで返る', async () => {
    mockAnthropicOnce(() => new Response(JSON.stringify({ error: { type: 'insufficient_quota' } }), { status: 429 }));

    const token = await signupAndGetToken();
    const res = await testConnection(token, { apiKey: USER_KEY, apiProvider: 'openai' });
    expect(res.status).toBe(429);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe('ai_upstream_rate_limited');
  });

  it('到達不能(fetch自体の失敗)はupstream_unreachableで返る', async () => {
    activeMock = installFetchMock(() => {
      throw new TypeError('network down');
    });

    const token = await signupAndGetToken();
    const res = await testConnection(token, { apiKey: USER_KEY, apiProvider: 'anthropic' });
    expect(res.status).toBe(502);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe('upstream_unreachable');
  });

  it('apiKey・apiProviderが欠けていれば400。上流には転送されない', async () => {
    const mock = installFetchMock(() => {
      throw new Error('fetchが呼ばれるべきではない');
    });
    activeMock = mock;

    const token = await signupAndGetToken();
    expect((await testConnection(token, { apiProvider: 'openai' })).status).toBe(400);
    expect((await testConnection(token, { apiKey: USER_KEY })).status).toBe(400);
    expect((await testConnection(token, { apiKey: USER_KEY, apiProvider: 'gemini' })).status).toBe(400);
    expect((await testConnection(token, { apiKey: 'sk-a\r\nx: 1', apiProvider: 'openai' })).status).toBe(400);
    expect(mock.calls).toHaveLength(0);
  });

  it('アカウントあたりの日次回数上限を超えると429(チャットの残量とは別枠)', async () => {
    env.AI_TEST_DAILY_LIMIT = '1';
    const mock = mockAnthropicOnce(() =>
      openAiSuccessResponse({
        choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      })
    );

    const token = await signupAndGetToken();
    expect((await testConnection(token, { apiKey: USER_KEY, apiProvider: 'openai' })).status).toBe(200);

    const second = await testConnection(token, { apiKey: USER_KEY, apiProvider: 'openai' });
    expect(second.status).toBe(429);
    expect((await second.json<{ error: { code: string } }>()).error.code).toBe('ai_test_limit_exceeded');
    // 上限超過時は上流を呼ばない(fetchは1回目のみ)
    expect(mock.calls).toHaveLength(1);
    // 接続テストの回数はチャットの残量に影響しない
    expect(await usedCount(token)).toBe(0);
  });
});

// モデル一覧(POST /api/ai/models)。設定画面の「接続テスト」がこれを呼ぶ
// (一覧の取得自体が疎通確認を兼ねる。src/index.tsのコメント参照)。
describe('POST /api/ai/models', () => {
  const originalTestLimit = env.AI_TEST_DAILY_LIMIT;
  const USER_KEY = 'sk-models-endpoint-user-key';
  const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';
  const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models';

  afterEach(() => {
    env.AI_TEST_DAILY_LIMIT = originalTestLimit;
  });

  async function listModels(token: string, requestBody: unknown) {
    return exports.default.fetch(`${BASE}/api/ai/models`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(requestBody),
    });
  }

  async function testConnection(token: string, requestBody: unknown) {
    return exports.default.fetch(`${BASE}/api/ai/test`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(requestBody),
    });
  }

  function modelsResponse(ids: string[]): Response {
    return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('認証なしは401', async () => {
    const res = await listModels('not-a-real-token', { apiKey: USER_KEY, apiProvider: 'openai' });
    expect(res.status).toBe(401);
  });

  it('成功(openai): チャット非対応のモデルを除外し、昇順で返す', async () => {
    const mock = mockAnthropicOnce((url) => {
      expect(url).toBe(OPENAI_MODELS_URL);
      return modelsResponse([
        'gpt-5.6-luna',
        'text-embedding-3-large',
        'whisper-1',
        'gpt-4.1-mini',
        'dall-e-3',
        'o3-mini',
        'gpt-3.5-turbo-instruct',
        'omni-moderation-latest',
        'gpt-4o-realtime-preview',
        'chatgpt-4o-latest',
        'babbage-002',
      ]);
    });

    const token = await signupAndGetToken();
    const res = await listModels(token, { apiKey: USER_KEY, apiProvider: 'openai' });

    expect(res.status).toBe(200);
    const body = await res.json<{ provider: string; models: string[] }>();
    expect(body.provider).toBe('openai');
    expect(body.models).toEqual(['chatgpt-4o-latest', 'gpt-4.1-mini', 'gpt-5.6-luna', 'o3-mini']);

    // 上流へは利用者キーだけを使う(サーバー側キーは使わない)
    const sentHeaders = mock.calls[0].init.headers as Record<string, string>;
    expect(sentHeaders.authorization).toBe(`Bearer ${USER_KEY}`);
  });

  it('成功(anthropic): x-api-key・anthropic-versionを付け、上流の並び順のまま返す', async () => {
    const mock = mockAnthropicOnce((url) => {
      expect(url).toBe(ANTHROPIC_MODELS_URL);
      return modelsResponse(['claude-haiku-5', 'claude-sonnet-5', 'claude-opus-4-1']);
    });

    const token = await signupAndGetToken();
    const res = await listModels(token, { apiKey: USER_KEY, apiProvider: 'anthropic' });

    expect(res.status).toBe(200);
    const body = await res.json<{ provider: string; models: string[] }>();
    expect(body.provider).toBe('anthropic');
    // 並べ替えない(API順=新しい順を保つ)
    expect(body.models).toEqual(['claude-haiku-5', 'claude-sonnet-5', 'claude-opus-4-1']);

    const sentHeaders = mock.calls[0].init.headers as Record<string, string>;
    expect(sentHeaders['x-api-key']).toBe(USER_KEY);
    expect(sentHeaders['x-api-key']).not.toBe(env.ANTHROPIC_API_KEY);
    expect(sentHeaders['anthropic-version']).toBe('2023-06-01');
  });

  it('認証失敗(401)はuser_api_key_invalidで返り、応答にキーの値を含まない', async () => {
    mockAnthropicOnce(() => new Response(JSON.stringify({ error: { code: 'invalid_api_key' } }), { status: 401 }));

    const token = await signupAndGetToken();
    const res = await listModels(token, { apiKey: USER_KEY, apiProvider: 'openai' });

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain(USER_KEY);
    expect(JSON.parse(text).error.code).toBe('user_api_key_invalid');
  });

  it('到達不能(fetch自体の失敗)はupstream_unreachableで返る', async () => {
    activeMock = installFetchMock(() => {
      throw new TypeError('network down');
    });

    const token = await signupAndGetToken();
    const res = await listModels(token, { apiKey: USER_KEY, apiProvider: 'anthropic' });
    expect(res.status).toBe(502);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe('upstream_unreachable');
  });

  it('apiKey・apiProviderの不備は400(ヘッダ注入を含む)。上流には転送されない', async () => {
    const mock = installFetchMock(() => {
      throw new Error('fetchが呼ばれるべきではない');
    });
    activeMock = mock;

    const token = await signupAndGetToken();
    expect((await listModels(token, { apiProvider: 'openai' })).status).toBe(400);
    expect((await listModels(token, { apiKey: USER_KEY })).status).toBe(400);
    expect((await listModels(token, { apiKey: USER_KEY, apiProvider: 'gemini' })).status).toBe(400);
    const injected = await listModels(token, { apiKey: 'sk-a\r\nx-injected: 1', apiProvider: 'openai' });
    expect(injected.status).toBe(400);
    expect((await injected.json<{ error: { code: string } }>()).error.code).toBe('invalid_request');
    expect(mock.calls).toHaveLength(0);
  });

  it('日次上限は接続テストと同じ枠を消費する(チャットの残量は消費しない)', async () => {
    env.AI_TEST_DAILY_LIMIT = '1';
    const mock = mockAnthropicOnce((url) =>
      url === 'https://api.openai.com/v1/chat/completions'
        ? openAiSuccessResponse({
            choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          })
        : modelsResponse(['gpt-5.6-luna'])
    );

    const token = await signupAndGetToken();
    // 1回目は接続テストで枠を使い切る
    expect((await testConnection(token, { apiKey: USER_KEY, apiProvider: 'openai' })).status).toBe(200);

    // 別枠を持たないため、モデル一覧の取得は上限超過になる
    const res = await listModels(token, { apiKey: USER_KEY, apiProvider: 'openai' });
    expect(res.status).toBe(429);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe('ai_test_limit_exceeded');
    // 上限超過時は上流を呼ばない(fetchは接続テストの1回だけ)
    expect(mock.calls).toHaveLength(1);
    // チャットの残量には影響しない
    const quotaBody = await (await quota(token)).json<{ used: number }>();
    expect(quotaBody.used).toBe(0);
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
