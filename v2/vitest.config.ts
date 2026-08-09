import { defineConfig } from 'vitest/config';

// shared(node環境)とclient(jsdom環境)をプロジェクトとして束ね、
// v2ルートの `npm run test` 1回で両方を実行する。
export default defineConfig({
  test: {
    projects: ['shared', 'client'],
  },
});
