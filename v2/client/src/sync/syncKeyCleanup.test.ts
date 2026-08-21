import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearBlobCleanupPending,
  isBlobCleanupPending,
  markBlobCleanupPending,
  runPendingBlobCleanup,
} from './syncKeyCleanup';

const ACCOUNT = 'acc-1';

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

describe('syncKeyCleanup', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('印が無ければ何もせず完了扱い(APIを呼ばない)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await runPendingBlobCleanup(ACCOUNT, 'tok')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('印が残っていれば差分を消し、成功したら印を消す', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { deleted: 2 }));
    vi.stubGlobal('fetch', fetchMock);
    markBlobCleanupPending(ACCOUNT);

    expect(await runPendingBlobCleanup(ACCOUNT, 'tok')).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/sync/blobs');
    expect(init.method).toBe('DELETE');
    expect(isBlobCleanupPending(ACCOUNT)).toBe(false);
  });

  it('失敗したら印を残す(次の契機で再試行される)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    markBlobCleanupPending(ACCOUNT);

    expect(await runPendingBlobCleanup(ACCOUNT, 'tok')).toBe(false);
    // ここが要。消してしまうと孤児blobが残ったまま誰も直せなくなる
    expect(isBlobCleanupPending(ACCOUNT)).toBe(true);
  });

  it('サーバーがエラーを返した場合も印を残す', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(500, { error: { code: 'server_error', message: 'サーバーエラー' } }),
      ),
    );
    markBlobCleanupPending(ACCOUNT);

    expect(await runPendingBlobCleanup(ACCOUNT, 'tok')).toBe(false);
    expect(isBlobCleanupPending(ACCOUNT)).toBe(true);
  });

  it('失敗しても例外を投げない(起動のたびにエラーを出さないため)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    markBlobCleanupPending(ACCOUNT);

    await expect(runPendingBlobCleanup(ACCOUNT, 'tok')).resolves.toBe(false);
  });

  it('一度失敗した後、通信できるようになれば消せる', async () => {
    markBlobCleanupPending(ACCOUNT);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await runPendingBlobCleanup(ACCOUNT, 'tok')).toBe(false);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { deleted: 1 })));
    expect(await runPendingBlobCleanup(ACCOUNT, 'tok')).toBe(true);
    expect(isBlobCleanupPending(ACCOUNT)).toBe(false);
  });

  it('印はアカウントごとに分かれる(別アカウントの後始末を巻き込まない)', async () => {
    markBlobCleanupPending(ACCOUNT);
    expect(isBlobCleanupPending('acc-2')).toBe(false);

    clearBlobCleanupPending(ACCOUNT);
    expect(isBlobCleanupPending(ACCOUNT)).toBe(false);
  });
});
