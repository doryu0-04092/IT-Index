import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchOrTranslateNetworkError } from './networkError';

describe('fetchOrTranslateNetworkError', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('translates a CORS/network-level fetch rejection into a Japanese message', async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(fetchOrTranslateNetworkError('https://example.com')).rejects.toThrow(
      'AIサービスに接続できませんでした',
    );
  });

  it('passes through a successful response unchanged', async () => {
    const response = new Response('ok', { status: 200 });
    global.fetch = vi.fn().mockResolvedValue(response);

    const result = await fetchOrTranslateNetworkError('https://example.com');

    expect(result).toBe(response);
  });

  it('does not swallow an HTTP error response (only network-level rejection is translated)', async () => {
    const response = new Response('nope', { status: 401 });
    global.fetch = vi.fn().mockResolvedValue(response);

    const result = await fetchOrTranslateNetworkError('https://example.com');

    expect(result.status).toBe(401);
  });
});
