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
    AI_TEST_DAILY_LIMIT?: string; // 既定はコード側の20(接続テストの上限テストのみtest内で上書きする)
    CORS_ALLOWED_ORIGIN?: string; // 既定は未設定(ローカル開発時のみtest内で上書きする)
    // ライセンス基盤(src/license.ts)。いずれも既定は未設定=ゲート有効・運営者コード無し。
    // 個別のテスト内で上書きし、finally/afterEachで元へ戻す(既存のAI_*系と同じ流儀)。
    LICENSE_ENABLED?: string;
    LICENSE_CODES?: string;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[]; // vitest.config.tsで定義
  }

  // `cloudflare:workers`のexports.default.fetch()に型を与えるため、
  // mainワーカー(src/index.ts)のモジュール型をGlobalPropsへ登録する。
  interface GlobalProps {
    mainModule: typeof import('../src/index');
  }
}
