import { defineConfig, devices } from '@playwright/test';

/**
 * 信頼性・データ整合性観点の調査専用config（一時ファイル）。
 * 他エージェントと同一のwebServer(4173)を使うと競合するため、自分専用のポート(4177)を使う。
 * サーバーは `npx vite preview --port 4177` を事前に別プロセスで起動しておく前提（webServerは使わない）。
 */
export default defineConfig({
  testDir: './e2e/investigate-reliability',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: 'http://localhost:4177',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
