import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setApiKey } from '../sync/apiKeyStore';
import { createProxyAiClient } from './aiClient';

function mockFetchOnce() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({ text: 'ok', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }),
  });
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

  it('端末に保存されたキーを呼び出しごとに読み直して同送する', async () => {
    const fetchMock = mockFetchOnce();
    vi.stubGlobal('fetch', fetchMock);

    const client = createProxyAiClient(() => 'tok');
    // クライアント生成後に保存しても、次の送信から反映される
    setApiKey('sk-user-key');
    await client.send({ messages: [{ role: 'user', content: 'hi' }] });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as Record<string, unknown>;
    expect(body.apiKey).toBe('sk-user-key');
  });
});
