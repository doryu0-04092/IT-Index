import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activateLicense,
  ApiRequestError,
  chatWithAi,
  fetchAiQuota,
  fetchMe,
  login,
  pullSyncBlobs,
  purchaseLicense,
  pushSyncBlob,
  signup,
  testAiConnection,
} from './apiClient';
import { clearServerBaseUrl, setServerBaseUrl } from './serverConfig';

function mockFetchOnce(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
}

describe('apiClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearServerBaseUrl();
  });

  it('signupは既定で/api/auth/signupへ相対パスでPOSTし、tokenを返す', async () => {
    const fetchMock = mockFetchOnce(201, { token: 'tok-1' });
    vi.stubGlobal('fetch', fetchMock);

    const result = await signup('a@example.com', 'password123');

    expect(result).toEqual({ token: 'tok-1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/auth/signup');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ email: 'a@example.com', password: 'password123' });
  });

  it('signupが409を返すとサーバーの日本語messageを持つApiRequestErrorを投げる', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOnce(409, { error: { code: 'email_taken', message: 'このメールアドレスは既に使用されています' } }),
    );

    await expect(signup('a@example.com', 'password123')).rejects.toMatchObject({
      message: 'このメールアドレスは既に使用されています',
      code: 'email_taken',
    });
  });

  it('loginは/api/auth/loginへPOSTする', async () => {
    const fetchMock = mockFetchOnce(200, { token: 'tok-2' });
    vi.stubGlobal('fetch', fetchMock);

    const result = await login('a@example.com', 'password123');

    expect(result).toEqual({ token: 'tok-2' });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/login');
  });

  it('fetchMeはAuthorization: Bearerヘッダを付ける', async () => {
    const fetchMock = mockFetchOnce(200, { accountId: 'acc-1', email: 'a@example.com' });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchMe('tok-3');

    expect(result).toEqual({ accountId: 'acc-1', email: 'a@example.com' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/auth/me');
    expect(init.headers.Authorization).toBe('Bearer tok-3');
  });

  it('pushSyncBlobはdeviceIdとpayloadを送りseqを受け取る', async () => {
    const fetchMock = mockFetchOnce(201, { seq: 7 });
    vi.stubGlobal('fetch', fetchMock);

    const result = await pushSyncBlob('tok', 'device-1', '{"payload":true}');

    expect(result).toEqual({ seq: 7 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/sync/push');
    expect(JSON.parse(init.body)).toEqual({ deviceId: 'device-1', payload: '{"payload":true}' });
  });

  it('pullSyncBlobsはsinceをクエリに付け、blobsとlatestを受け取る', async () => {
    const fetchMock = mockFetchOnce(200, {
      blobs: [{ seq: 1, deviceId: 'device-2', payload: '{}', createdAt: 1000 }],
      latest: 1,
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await pullSyncBlobs('tok', 0);

    expect(result.latest).toBe(1);
    expect(result.blobs).toHaveLength(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/sync/pull?since=0');
  });

  it('通信自体が失敗した場合はnetwork_errorのApiRequestErrorを投げる', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    await expect(login('a@example.com', 'password123')).rejects.toBeInstanceOf(ApiRequestError);
  });

  it('chatWithAiはAuthorizationヘッダとmessages/systemを送りtext/stopReason/usageを受け取る', async () => {
    const fetchMock = mockFetchOnce(200, {
      text: 'こたえ',
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await chatWithAi('tok', [{ role: 'user', content: 'こんにちは' }], 'system指示');

    expect(result).toEqual({ text: 'こたえ', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/ai/chat');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body)).toEqual({ messages: [{ role: 'user', content: 'こんにちは' }], system: 'system指示' });
  });

  it('chatWithAiは429の場合サーバーの日本語messageを持つApiRequestErrorを投げる', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOnce(429, {
        error: { code: 'ai_limit_exceeded', message: '本日の利用回数の上限に達しました。明日また利用できます' },
      }),
    );

    await expect(chatWithAi('tok', [{ role: 'user', content: 'こんにちは' }])).rejects.toMatchObject({
      message: '本日の利用回数の上限に達しました。明日また利用できます',
      code: 'ai_limit_exceeded',
      status: 429,
    });
  });

  it('chatWithAiはcredentialが未指定・null・空キーならapiKey系フィールドを送らない', async () => {
    for (const credential of [undefined, null, { key: '', provider: 'openai' as const }]) {
      const fetchMock = mockFetchOnce(200, {
        text: 'こたえ',
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      vi.stubGlobal('fetch', fetchMock);

      await chatWithAi('tok', [{ role: 'user', content: 'hi' }], undefined, credential);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body) as Record<string, unknown>;
      expect(body).toEqual({ messages: [{ role: 'user', content: 'hi' }] });
      expect('apiKey' in body).toBe(false);
      expect('apiProvider' in body).toBe(false);
      vi.unstubAllGlobals();
    }
  });

  it('chatWithAiはcredentialが設定されていればapiKey・apiProvider・modelを付ける', async () => {
    const fetchMock = mockFetchOnce(200, {
      text: 'こたえ',
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    vi.stubGlobal('fetch', fetchMock);

    await chatWithAi('tok', [{ role: 'user', content: 'hi' }], 'system指示', {
      key: 'sk-user-key',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as Record<string, unknown>;
    expect(body).toEqual({
      messages: [{ role: 'user', content: 'hi' }],
      system: 'system指示',
      apiKey: 'sk-user-key',
      apiProvider: 'anthropic',
      model: 'claude-sonnet-5',
    });
  });

  it('chatWithAiはmodel未指定ならmodelフィールドを送らない(サーバー側の既定に任せる)', async () => {
    const fetchMock = mockFetchOnce(200, {
      text: 'こたえ',
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    vi.stubGlobal('fetch', fetchMock);

    await chatWithAi('tok', [{ role: 'user', content: 'hi' }], undefined, {
      key: 'sk-user-key',
      provider: 'openai',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as Record<string, unknown>;
    expect(body.apiProvider).toBe('openai');
    expect('model' in body).toBe(false);
  });

  it('testAiConnectionは/ai/testへapiKey・apiProvider(・model)を送りok/provider/model/usageを受け取る', async () => {
    const fetchMock = mockFetchOnce(200, {
      ok: true,
      provider: 'openai',
      model: 'gpt-5.6-luna',
      usage: { inputTokens: 2, outputTokens: 1 },
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await testAiConnection('tok', { key: 'sk-user-key', provider: 'openai' });

    expect(result.model).toBe('gpt-5.6-luna');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/ai/test');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body)).toEqual({ apiKey: 'sk-user-key', apiProvider: 'openai' });
  });

  it('testAiConnectionは失敗時サーバーの日本語messageとcodeを持つApiRequestErrorを投げる', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOnce(400, {
        error: { code: 'user_model_invalid', message: '指定したモデル名が使えません。設定画面でモデル名を確認してください' },
      }),
    );

    await expect(
      testAiConnection('tok', { key: 'sk-user-key', provider: 'anthropic', model: 'bad-model' }),
    ).rejects.toMatchObject({
      code: 'user_model_invalid',
      message: '指定したモデル名が使えません。設定画面でモデル名を確認してください',
      status: 400,
    });
  });

  it('chatWithAiはuser_api_key_invalidをコード付きのApiRequestErrorとして投げる', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOnce(400, {
        error: {
          code: 'user_api_key_invalid',
          message: '設定したAPIキーが無効です。設定画面で確認してください',
        },
      }),
    );

    await expect(
      chatWithAi('tok', [{ role: 'user', content: 'hi' }], undefined, { key: 'sk-bad', provider: 'openai' }),
    ).rejects.toMatchObject({
      code: 'user_api_key_invalid',
      message: '設定したAPIキーが無効です。設定画面で確認してください',
      status: 400,
    });
  });

  it('fetchAiQuotaはused/limitを受け取る', async () => {
    const fetchMock = mockFetchOnce(200, { used: 3, limit: 50 });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchAiQuota('tok');

    expect(result).toEqual({ used: 3, limit: 50 });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/ai/quota');
  });

  it('purchaseLicenseは/api/license/purchaseへAuthorization付きでPOSTし、code/activatedAtを受け取る', async () => {
    const fetchMock = mockFetchOnce(201, { code: 'ABCD-1234', activatedAt: 1000 });
    vi.stubGlobal('fetch', fetchMock);

    const result = await purchaseLicense('tok');

    expect(result).toEqual({ code: 'ABCD-1234', activatedAt: 1000 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/license/purchase');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  it('purchaseLicenseは既に有効な場合409をcode付きのApiRequestErrorとして投げる', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOnce(409, {
        error: { code: 'license_already_active', message: 'このアカウントには既に有効なライセンスがあります' },
      }),
    );

    await expect(purchaseLicense('tok')).rejects.toMatchObject({
      code: 'license_already_active',
      message: 'このアカウントには既に有効なライセンスがあります',
      status: 409,
    });
  });

  it('activateLicenseはcodeを送りactivatedAtを受け取る', async () => {
    const fetchMock = mockFetchOnce(200, { activatedAt: 2000 });
    vi.stubGlobal('fetch', fetchMock);

    const result = await activateLicense('tok', 'CODE-1');

    expect(result).toEqual({ activatedAt: 2000 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/license/activate');
    expect(JSON.parse(init.body)).toEqual({ code: 'CODE-1' });
  });

  it('activateLicenseは無効なコードで403をcode付きのApiRequestErrorとして投げる', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOnce(403, {
        error: { code: 'license_invalid', message: 'ライセンスコードが正しくありません。入力内容を確認してください' },
      }),
    );

    await expect(activateLicense('tok', 'bad-code')).rejects.toMatchObject({
      code: 'license_invalid',
      status: 403,
    });
  });

  it('接続先サーバーが設定されていれば、全リクエストの基底URLがそれに切り替わる(一元化点: apiUrl())', async () => {
    setServerBaseUrl('https://self-hosted.example.workers.dev');
    const fetchMock = mockFetchOnce(200, { token: 'tok-x' });
    vi.stubGlobal('fetch', fetchMock);

    await login('a@example.com', 'password123');

    expect(fetchMock.mock.calls[0][0]).toBe('https://self-hosted.example.workers.dev/api/auth/login');
  });
});
