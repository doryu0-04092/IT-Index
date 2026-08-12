import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearServerBaseUrl,
  getServerBaseUrl,
  setServerBaseUrl,
  testServerConnection,
  validateServerUrl,
} from './serverConfig';

describe('serverConfig', () => {
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  describe('validateServerUrl', () => {
    it('httpsのURLは通す', () => {
      const result = validateServerUrl('https://example.workers.dev/');
      expect(result).toEqual({ ok: true, normalized: 'https://example.workers.dev' });
    });

    it('末尾スラッシュを正規化(除去)する', () => {
      const result = validateServerUrl('https://example.workers.dev///');
      expect(result.ok).toBe(true);
      expect(result.ok && result.normalized).toBe('https://example.workers.dev');
    });

    it('localhostのhttpは許可する', () => {
      const result = validateServerUrl('http://localhost:8787');
      expect(result).toEqual({ ok: true, normalized: 'http://localhost:8787' });
    });

    it('localhost以外のhttpは拒否する', () => {
      const result = validateServerUrl('http://example.workers.dev');
      expect(result.ok).toBe(false);
    });

    it('空文字は拒否する', () => {
      expect(validateServerUrl('  ').ok).toBe(false);
    });

    it('URLとして不正な文字列は拒否する', () => {
      expect(validateServerUrl('not a url').ok).toBe(false);
    });
  });

  describe('保存・読み出し・既定に戻す', () => {
    it('未設定ならnull(公式ホスト・同一オリジン)', () => {
      expect(getServerBaseUrl()).toBeNull();
    });

    it('保存すると読み出せる', () => {
      setServerBaseUrl('https://example.workers.dev');
      expect(getServerBaseUrl()).toBe('https://example.workers.dev');
    });

    it('既定に戻すと未設定になる', () => {
      setServerBaseUrl('https://example.workers.dev');
      clearServerBaseUrl();
      expect(getServerBaseUrl()).toBeNull();
    });
  });

  describe('testServerConnection', () => {
    it('GET {url}/api/healthが200・status:okを返せば成功', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ status: 'ok' }) });
      vi.stubGlobal('fetch', fetchMock);

      const result = await testServerConnection('https://example.workers.dev');

      expect(result).toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledWith('https://example.workers.dev/api/health');
    });

    it('応答が失敗(ok:false)なら保存を促さないエラーを返す', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve(null) }));

      const result = await testServerConnection('https://example.workers.dev');

      expect(result.ok).toBe(false);
    });

    it('通信自体が失敗した場合もエラーを返す', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

      const result = await testServerConnection('https://example.workers.dev');

      expect(result.ok).toBe(false);
    });
  });
});
