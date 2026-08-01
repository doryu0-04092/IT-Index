import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
import path from 'node:path';
import { test as base, type Page } from '@playwright/test';

/**
 * アクセシビリティ観点の調査専用スペック（一時ファイル）。
 * e2e/fixtures/base.ts の preparedPage は使わず、モーダル遷移の都合上ここで個別に組み立てる。
 * このファイルは調査終了後に削除してよい。
 */

const SHOT_DIR = 'docs/review/agents/screenshots/a11y';

async function mockAiProviders(page: Page): Promise<void> {
  // Playwright: 複数マッチした場合は「後から登録した route」が優先される。
  // /v1/models 専用の route を必ず最後に登録し、汎用 route に上書きされないようにする。
  await page.route('https://api.anthropic.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ content: [{ type: 'text', text: 'モック応答です。' }] }),
    }),
  );
  await page.route('https://api.anthropic.com/v1/models', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: 'claude-mock-model' }] }),
    }),
  );
  await page.route('https://api.openai.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: 'モック応答です。' } }] }) }),
  );
  await page.route('https://generativelanguage.googleapis.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'モック応答です。' }] } }] }) }),
  );
}

async function freshPage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    indexedDB.deleteDatabase('it-index');
    localStorage.clear();
  });
  await mockAiProviders(page);
  await page.goto('/');
  // 初回計測でscreen-fade-in等のCSSアニメーション中(opacity<1)にaxeを実行してしまい、
  // color-contrastの計測値が不正確になっていたための修正（e2e/fixtures/base.tsのfreezeTimeAndAnimationsに倣う）。
  await page.addStyleTag({
    content: `*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; }`,
  });
  await page.waitForSelector('.search-status', { timeout: 20_000 });
}

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
}

async function dismissOnboardingIfPresent(page: Page): Promise<void> {
  const closeBtn = page.locator('.onboarding-content .dismiss-error');
  if (await closeBtn.count()) {
    await closeBtn.click();
  }
}

async function runAxe(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const outPath = path.join('docs/review/agents/screenshots/a11y', `${label}.axe.json`);
  fs.writeFileSync(outPath, JSON.stringify(results.violations, null, 2), 'utf-8');
  const blocking = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  console.log(`=== ${label} === violations: ${results.violations.length}, blocking: ${blocking.length}`);
  for (const v of results.violations) {
    console.log(`  [${v.impact}] ${v.id}: ${v.nodes.length} node(s) - ${v.help}`);
    for (const n of v.nodes) {
      console.log(`      target=${JSON.stringify(n.target)} html=${n.html.slice(0, 160)}`);
    }
  }
  await page.screenshot({ path: path.join(SHOT_DIR, `${label}.png`), fullPage: true });
  return results;
}

const test = base;

for (const theme of ['light', 'dark'] as const) {
  test(`search screen [${theme}]`, async ({ page }) => {
    await freshPage(page);
    await setTheme(page, theme);
    await dismissOnboardingIfPresent(page);
    await runAxe(page, `search-${theme}`);
  });

  test(`detail screen [${theme}]`, async ({ page }) => {
    await freshPage(page);
    await setTheme(page, theme);
    await dismissOnboardingIfPresent(page);
    await page.fill('.search-input', 'HTTP');
    await page.waitForTimeout(300);
    const firstResult = page.locator('.search-result').first();
    await firstResult.waitFor({ state: 'visible', timeout: 10_000 });
    await firstResult.click();
    await page.waitForSelector('.term-detail');
    await runAxe(page, `detail-${theme}`);
  });

  test(`chat screen (apikeyprompt, full-screen) [${theme}]`, async ({ page }) => {
    await freshPage(page);
    await setTheme(page, theme);
    await dismissOnboardingIfPresent(page);
    await page.getByText('自由に質問', { exact: true }).click();
    await page.waitForSelector('.api-key-prompt');
    await runAxe(page, `chat-apikeyprompt-${theme}`);
  });

  test(`chat screen (with key ready) [${theme}]`, async ({ page }) => {
    await freshPage(page);
    await setTheme(page, theme);
    await dismissOnboardingIfPresent(page);
    await page.getByText('自由に質問', { exact: true }).click();
    await page.waitForSelector('.api-key-prompt');
    await page.fill('.api-key-field input[type="password"]', 'sk-test-dummy-key');
    await page.click('.api-key-prompt button[type="submit"]');
    await page.waitForSelector('.api-key-prompt select', { timeout: 10_000 });
    await page.click('.api-key-prompt button[type="submit"]');
    await page.waitForSelector('.chat-screen', { timeout: 10_000 });
    await runAxe(page, `chat-ready-${theme}`);
  });

  test(`history screen [${theme}]`, async ({ page }) => {
    await freshPage(page);
    await setTheme(page, theme);
    await dismissOnboardingIfPresent(page);
    await page.getByText('履歴', { exact: true }).click();
    await page.waitForSelector('.history-screen');
    await runAxe(page, `history-${theme}`);
  });

  test(`SettingsModal [${theme}]`, async ({ page }) => {
    await freshPage(page);
    await setTheme(page, theme);
    await dismissOnboardingIfPresent(page);
    await page.getByText('設定', { exact: true }).click();
    await page.waitForSelector('.modal-content');
    await runAxe(page, `settings-modal-${theme}`);
  });

  test(`SettingsModal -> ApiKeyPrompt (editingKey) [${theme}]`, async ({ page }) => {
    await freshPage(page);
    await setTheme(page, theme);
    await dismissOnboardingIfPresent(page);
    await page.getByText('設定', { exact: true }).click();
    await page.waitForSelector('.modal-content');
    await page.click('.settings-section button.btn-secondary');
    await page.waitForSelector('.api-key-prompt');
    await runAxe(page, `settings-apikeyprompt-modal-${theme}`);
  });

  test(`OnboardingModal [${theme}]`, async ({ page }) => {
    await freshPage(page);
    await setTheme(page, theme);
    // dismiss しない。初回表示のまま検証する
    await page.waitForSelector('.onboarding-content');
    await runAxe(page, `onboarding-modal-${theme}`);
  });
}
