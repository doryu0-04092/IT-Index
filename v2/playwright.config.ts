import { defineConfig, devices } from '@playwright/test';

/**
 * v1(../playwright.config.ts)と同じ決定性優先の方針:
 * retries: 0 / workers: 1。ポートはv1のE2E(4173)と衝突しないよう4174を使う。
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: 'http://127.0.0.1:4174',
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
  /**
   * **本番と同じ構成で立てる(#231)。** wrangler は同一Workerで /api/* と ../client/dist の
   * 静的配信を両方行う——これは本番とまったく同じ形。
   *
   * 以前は vite preview で静的配信だけしていたため /api が存在せず、
   * ログイン・同期・競合表示は画面越しに一度も動かされていなかった。
   * 単体テストが緑であることは「画面から使える」ことを何も保証しない。
   *
   * LICENSE_ENABLED=0: 公式ホストは同期に有効なライセンスを要求するが、ここで確かめたいのは
   * 画面から同期が通ることであって課金導線ではない(ライセンスゲート自体は server/test が見ている)。
   */
  webServer: {
    command: 'npm run build -w client && npm run dev:e2e -w server',
    url: 'http://127.0.0.1:4174/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
