import { test } from '../fixtures/base';
import type { Page } from '@playwright/test';
import fs from 'node:fs';

// 調査用の一時spec。ビジュアルデザイン検証のため、全画面・全モーダルをライト/ダーク両方で
// スクリーンショット撮影する。既存のvisual specとは別ファイル（既存は変更しない）。

const OUT_DIR = 'docs/review/agents/screenshots/visual';
fs.mkdirSync(OUT_DIR, { recursive: true });

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
}

// オンボーディングモーダルは初回起動時に必ず出る。reloadすると、preparedPageが
// addStyleTagで注入したアニメーション凍結スタイルがDOMごと消え、以降のスクリーンショットに
// 残存フェードアニメーションが写り込んでしまう（実際に発生を確認した）。そのためreloadせず、
// モーダルの「スキップ」ボタンをクリックして閉じる。
async function skipOnboardingAndSetTheme(page: Page, theme: 'light' | 'dark') {
  const modal = page.locator('.modal-content.onboarding-content');
  if ((await modal.count()) > 0) {
    await page.click('.onboarding-actions >> text=スキップ');
    await modal.waitFor({ state: 'hidden' });
  }
  await setTheme(page, theme);
}

for (const theme of ['light', 'dark'] as const) {
  test(`search画面（${theme}）`, async ({ preparedPage: page }) => {
    await skipOnboardingAndSetTheme(page, theme);
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT_DIR}/search-${theme}.png`, fullPage: true });
  });

  test(`search画面・入力あり（${theme}）`, async ({ preparedPage: page }) => {
    await skipOnboardingAndSetTheme(page, theme);
    await page.fill('.search-input', 'ネットワーク');
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT_DIR}/search-query-${theme}.png`, fullPage: true });
  });

  test(`detail画面（${theme}）`, async ({ preparedPage: page }) => {
    await skipOnboardingAndSetTheme(page, theme);
    await page.fill('.search-input', 'ネットワーク');
    await page.waitForTimeout(400);
    await page.locator('.search-result').first().click();
    await page.waitForSelector('.term-detail');
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT_DIR}/detail-${theme}.png`, fullPage: true });
  });

  test(`chat画面（${theme}）`, async ({ preparedPage: page }) => {
    // listModelsForProvider（APIキー疎通確認を兼ねるモデル一覧取得）はチャット応答とは別の
    // エンドポイント（/v1/models）を叩く。fixtures/base.tsの共通モックは/v1/messages想定の
    // 形状しか返さないため、ここだけ個別に上書きする。
    await page.route('https://api.anthropic.com/v1/models', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ id: 'claude-test-model' }] }) }),
    );
    await skipOnboardingAndSetTheme(page, theme);
    await page.click('.top-nav-item >> text=自由に質問');
    await page.waitForTimeout(200);
    // APIキー未設定ならApiKeyPromptが出る。ここではまずキーを設定してチャット本体画面を撮る。
    const hasPrompt = await page.locator('.api-key-prompt').count();
    if (hasPrompt > 0) {
      await page.fill('.api-key-field input[type="password"]', 'sk-test-dummy-key-0000000000000000');
      await page.click('.api-key-prompt button[type="submit"]');
      await page.waitForTimeout(500);
      const modelStepVisible = await page.locator('.api-key-prompt form').count();
      if (modelStepVisible > 0) {
        await page.click('.api-key-prompt button[type="submit"]').catch(() => {});
        await page.waitForTimeout(300);
      }
    }
    await page.waitForSelector('.chat-messages', { timeout: 10_000 }).catch(() => {});
    // メッセージバブル（ユーザー発言・AI返信）の見た目も確認したいので1往復送る
    await page.fill('.chat-input-row textarea', 'テスト質問です').catch(() => {});
    await page.click('.chat-input-row button:has-text("送信")').catch(() => {});
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT_DIR}/chat-${theme}.png`, fullPage: true });
  });

  test(`history画面（${theme}）`, async ({ preparedPage: page }) => {
    await skipOnboardingAndSetTheme(page, theme);
    await page.click('.top-nav-item >> text=履歴');
    await page.waitForSelector('.history-tabs');
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT_DIR}/history-${theme}.png`, fullPage: true });
  });

  test(`SettingsModal（${theme}）`, async ({ preparedPage: page }) => {
    await skipOnboardingAndSetTheme(page, theme);
    await page.click('.top-nav-item >> text=設定');
    await page.waitForSelector('.modal-content');
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT_DIR}/settings-modal-${theme}.png`, fullPage: true });
  });

  test(`OnboardingModal（${theme}）`, async ({ preparedPage: page }) => {
    // このテストだけはあえてスキップさせない（既定でlocalStorageは空のはず）。
    await setTheme(page, theme);
    await page.waitForSelector('.modal-content.onboarding-content', { timeout: 5000 });
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT_DIR}/onboarding-modal-${theme}.png`, fullPage: true });
  });

  test(`ApiKeyPrompt（${theme}）`, async ({ preparedPage: page }) => {
    await page.route('https://api.anthropic.com/v1/models', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ id: 'claude-test-model' }] }) }),
    );
    await skipOnboardingAndSetTheme(page, theme);
    await page.click('.top-nav-item >> text=自由に質問');
    await page.waitForSelector('.api-key-prompt', { timeout: 5000 });
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT_DIR}/apikeyprompt-step1-${theme}.png`, fullPage: true });

    await page.fill('.api-key-field input[type="password"]', 'sk-test-dummy-key-0000000000000000');
    await page.click('.api-key-prompt button[type="submit"]');
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT_DIR}/apikeyprompt-step2-${theme}.png`, fullPage: true });
  });
}
