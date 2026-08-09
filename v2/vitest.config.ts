import { defineConfig } from 'vitest/config';

// shared(node環境)・client(jsdom環境)・server(Cloudflare Workers環境)をプロジェクトとして束ね、
// v2ルートの `npm run test` 1回で全部を実行する。
// server配下は @cloudflare/vitest-pool-workers 独自のプール設定を持つ vitest.config.ts を
// 自前で読み込むため、ここではディレクトリを指すだけで良い(vitest workspaceの標準的な使い方)。
export default defineConfig({
  test: {
    projects: ['shared', 'client', 'server'],
  },
});
