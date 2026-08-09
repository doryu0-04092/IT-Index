import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, fetchMe, login, pullSyncBlobs, pushSyncBlob, signup } from './apiClient';

function mockFetchOnce(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
}

describe('apiClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
});
