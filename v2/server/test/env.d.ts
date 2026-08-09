declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    JWT_SECRET: string;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[]; // vitest.config.tsで定義
  }

  // `cloudflare:workers`のexports.default.fetch()に型を与えるため、
  // mainワーカー(src/index.ts)のモジュール型をGlobalPropsへ登録する。
  interface GlobalProps {
    mainModule: typeof import('../src/index');
  }
}
