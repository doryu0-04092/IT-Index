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
  /**
   * `investigate-*` は 2026-08-01 の品質検証で使った**使い捨ての調査スクリプト**で、
   * 各ファイル自身が「調査終了後に削除してよい」と宣言している。恒久的な回帰テストではない。
   * 既に現行UIに追従しておらず（2026-08-04の設定画面モーダル→画面化に未対応）、
   * 既定の実行に混ざると失敗が支配的でゲートとして機能しない
   * （2026-08-09 実測: 72件中46件失敗の大半がこれ）。
   * 恒久ゲートは `e2e/a11y/` と `e2e/visual/`。調査specを回す時はパスを明示指定する。
   */
  testIgnore: ['**/investigate-*/**'],
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
