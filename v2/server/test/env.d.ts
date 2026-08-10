declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    JWT_SECRET: string;
    AI_PROVIDER?: string;
    ANTHROPIC_API_KEY?: string;
    OPENAI_API_KEY?: string;
    AI_MODEL: string;
    AI_MAX_TOKENS: string;
    AI_DAILY_LIMIT_PER_USER: string;
    AI_DAILY_LIMIT_GLOBAL: string;
    CORS_ALLOWED_ORIGIN?: string; // 既定は未設定(ローカル開発時のみtest内で上書きする)
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[]; // vitest.config.tsで定義
  }

  // `cloudflare:workers`のexports.default.fetch()に型を与えるため、
  // mainワーカー(src/index.ts)のモジュール型をGlobalPropsへ登録する。
  interface GlobalProps {
    mainModule: typeof import('../src/index');
  }
}
