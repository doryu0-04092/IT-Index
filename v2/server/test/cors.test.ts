import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import app from '../src/index';

const BASE = 'https://example.com';

// CORS_ALLOWED_ORIGINはローカル開発専用(vite:5173→wrangler:8787)。
// 本番は同一オリジン配信のため未設定=ヘッダ無し、が既定の安全な状態であることを確認する。
// exports.default(cloudflare:workers)経由のfetch()はRPC境界を通るため.request()やenv差し替えが
// 使えない。ここではHonoアプリを直接importし、.request()にテスト用envを渡す。
describe('CORS', () => {
  it('CORS_ALLOWED_ORIGIN未設定時はAccess-Control-Allow-Originヘッダを付けない', async () => {
    const res = await app.request(
      `${BASE}/api/health`,
      { headers: { origin: 'https://example.org' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('CORS_ALLOWED_ORIGIN設定時は許可したオリジンにAccess-Control-Allow-Originヘッダを付ける', async () => {
    const res = await app.request(
      `${BASE}/api/health`,
      { headers: { origin: 'https://example.org' } },
      { ...env, CORS_ALLOWED_ORIGIN: 'https://example.org' }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://example.org');
  });
});
