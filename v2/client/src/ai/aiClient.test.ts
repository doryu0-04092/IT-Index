import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAiCredential, markCredentialUnverified, saveVerifiedCredential } from '../sync/apiKeyStore';
import { createProxyAiClient } from './aiClient';

function mockFetchOnce() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({ text: 'ok', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }),
  });
}

function mockFetchError(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({ ok: false, status, json: () => Promise.resolve(body) });
}

describe('createProxyAiClient', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('未ログインならAPIを呼ばずに例外にする', async () => {
    const fetchMock = mockFetchOnce();
    vi.stubGlobal('fetch', fetchMock);

    const client = createProxyAiClient(() => null);
    await expect(client.send({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
      'AIチャットにはログインが必要です',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('端末にキーが保存されていなければapiKeyを送らない', async () => {
    const fetchMock = mockFetchOnce();
    vi.stubGlobal('fetch', fetchMock);

    const client = createProxyAiClient(() => 'tok');
    await client.send({ messages: [{ role: 'user', content: 'hi' }] });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as Record<string, unknown>;
    expect('apiKey' in body).toBe(false);
  });

  it('検証済みのキーを呼び出しごとに読み直し、プロバイダとモデルも同送する', async () => {
    const fetchMock = mockFetchOnce();
    vi.stubGlobal('fetch', fetchMock);

    const client = createProxyAiClient(() => 'tok');
    // クライアント生成後に保存しても、次の送信から反映される
    saveVerifiedCredential({ key: 'sk-user-key', provider: 'anthropic', model: 'claude-sonnet-5' });
    await client.send({ messages: [{ role: 'user', content: 'hi' }] });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as Record<string, unknown>;
    expect(body.apiKey).toBe('sk-user-key');
    expect(body.apiProvider).toBe('anthropic');
    expect(body.model).toBe('claude-sonnet-5');
  });

  it('未検証(接続テストに通っていない)のキーは送らない', async () => {
    const fetchMock = mockFetchOnce();
    vi.stubGlobal('fetch', fetchMock);

    saveVerifiedCredential({ key: 'sk-user-key', provider: 'openai' });
    markCredentialUnverified();

    const client = createProxyAiClient(() => 'tok');
    await client.send({ messages: [{ role: 'user', content: 'hi' }] });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as Record<string, unknown>;
    expect('apiKey' in body).toBe(false);
  });

  it('user_api_key_invalidが返ったら検証済みフラグを解除する(キーは残す)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchError(400, {
        error: { code: 'user_api_key_invalid', message: '設定したAPIキーが無効です。設定画面で確認してください' },
      }),
    );
    saveVerifiedCredential({ key: 'sk-user-key', provider: 'openai' });

    const client = createProxyAiClient(() => 'tok');
    await expect(client.send({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({
      code: 'user_api_key_invalid',
    });

    expect(getAiCredential()?.verified).toBe(false);
    expect(getAiCredential()?.key).toBe('sk-user-key');
  });

  it('その他のエラーでは検証済みフラグを解除しない', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchError(429, {
        error: { code: 'ai_upstream_rate_limited', message: 'AIが混み合っています' },
      }),
    );
    saveVerifiedCredential({ key: 'sk-user-key', provider: 'openai' });

    const client = createProxyAiClient(() => 'tok');
    await expect(client.send({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({
      code: 'ai_upstream_rate_limited',
    });

    expect(getAiCredential()?.verified).toBe(true);
  });
});
