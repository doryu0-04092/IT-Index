import { env, exports } from 'cloudflare:workers';

// テスト共通のセットアップ。ライセンスゲート(src/license.ts)の導入により、
// 同期・運営者キーのAIチャットを叩くテストは「ライセンスを持つアカウント」を必要とする。
// 各テストファイルでSQLを書き散らさないよう、アカウント作成とライセンス付与をここに集約する。

export const BASE = 'https://example.com';

// このvitest-pool-workersのバージョン(0.20.3)には`cloudflare:test`の
// `fetchMock`(undici MockAgent)が存在しない(型定義・ランタイムいずれにも無し。
// 依存追加/更新は禁止のため、globalThis.fetchを直接差し替える方式で代替する)。
export type FetchCall = { url: string; init: RequestInit };

export function installFetchMock(handler: (url: string, init: RequestInit) => Response) {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const resolvedInit = init ?? {};
    calls.push({ url, init: resolvedInit });
    return handler(url, resolvedInit);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

export function authHeaders(token: string) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

/**
 * 有効化済みライセンスを直接1件入れる(APIを介さないため、購入・有効化エンドポイントの
 * 試行上限を消費しない)。codeは他テストと衝突しないUUID由来にする。
 */
export async function grantLicense(accountId: string): Promise<string> {
  const code = `TEST-${crypto.randomUUID()}`;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO licenses (code, account_id, source, issued_at, activated_at)
     VALUES (?1, ?2, 'operator', ?3, ?3)`
  )
    .bind(code, accountId, now)
    .run();
  return code;
}

/** 未有効化のコード(発行済み在庫)を1件入れる。activate経路(b)の検証用 */
export async function issueUnactivatedLicense(code: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO licenses (code, account_id, source, issued_at, activated_at)
     VALUES (?1, NULL, 'purchase', ?2, NULL)`
  )
    .bind(code, Date.now())
    .run();
}

export type Account = { token: string; accountId: string; email: string };

/**
 * サインアップしてトークンとaccountIdを返す。既定でライセンスを付与する
 * (ライセンス自体を検証するテストだけ `{ license: false }` を渡す)。
 */
export async function signupAccount(
  prefix: string,
  options: { license?: boolean } = {}
): Promise<Account> {
  const email = `${prefix}-${crypto.randomUUID()}@example.com`;
  const res = await exports.default.fetch(`${BASE}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123' }),
  });
  const body = await res.json<{ token: string }>();

  const row = await env.DB.prepare('SELECT id FROM accounts WHERE email = ?1')
    .bind(email)
    .first<{ id: string }>();
  if (!row) throw new Error(`signup failed for ${email} (status ${res.status})`);

  if (options.license !== false) await grantLicense(row.id);
  return { token: body.token, accountId: row.id, email };
}
