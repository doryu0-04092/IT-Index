import { defineConfig, devices } from '@playwright/test';

/**
 * 判定器の決定性を優先した設定。
 * 根拠: docs/review 配下の品質検証計画（プロンプト設計-品質ゲート「ゲート6」）。
 * - retries: 0 … リトライで不安定なテストを覆い隠さない
 * - workers: 1 … IndexedDBを共有するため並列実行させない
 * - screenshot比較は各テスト側で animations:'disabled' を指定する
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['html', { outputFolder: 'docs/review/logs/playwright-report', open: 'never' }], ['list']],
  timeout: 30_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: { maxDiffPixels: 0 },
  },
  use: {
    baseURL: 'http://localhost:4173',
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
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
