import { sign, verify } from 'hono/jwt';
import type { MiddlewareHandler } from 'hono';
import type { Env } from './types';

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

type JwtPayload = { sub: string; exp: number };

export async function issueToken(accountId: string, secret: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + THIRTY_DAYS_SECONDS;
  return sign({ sub: accountId, exp }, secret, 'HS256');
}

export type AuthedVariables = {
  accountId: string;
};

function unauthorized() {
  return { error: { code: 'unauthorized', message: '認証が必要です' } };
}

// 認証必須エンドポイント用ミドルウェア。トークン欠落・検証失敗のいずれも
// 同じ401レスポンスにまとめる(存在有無の差異を漏らさない設計をここでも踏襲)。
export const requireAuth: MiddlewareHandler<{ Bindings: Env; Variables: AuthedVariables }> = async (c, next) => {
  const header = c.req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  if (!token) {
    return c.json(unauthorized(), 401);
  }

  try {
    const payload = (await verify(token, c.env.JWT_SECRET, 'HS256')) as JwtPayload;
    c.set('accountId', payload.sub);
  } catch {
    return c.json(unauthorized(), 401);
  }

  await next();
};
