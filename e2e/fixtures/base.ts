import { test as base, type Page } from '@playwright/test';

/**
 * 共通fixture。判定器の決定性を成立させるための前処理をここに集約する。
 * 根拠: docs/review/ 配下の品質検証計画「ゲート6」の非決定性対処表。
 */

async function resetIndexedDb(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // it-indexのDB名はsrc/db.tsで固定（'it-index'）。テスト間の状態共有を断つため毎回削除する。
    indexedDB.deleteDatabase('it-index');
  });
}

async function mockAiProviders(page: Page): Promise<void> {
  // 実APIキーを使わない方針（本人合意済み）。3プロバイダの呼び出しを全てモックする。
  await page.route('https://api.anthropic.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: 'モック応答です。' }] }) })
  );
  await page.route('https://api.openai.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: 'モック応答です。' } }] }) })
  );
  await page.route('https://generativelanguage.googleapis.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'モック応答です。' }] } }] }) })
  );
}

async function waitForSeedSettled(page: Page): Promise<void> {
  // App.tsxはseedSettledが立つまでSearchScreen/TermDetailScreenを描画しない（docs/ui-pc.md §3 バグ2）。
  // シード取り込み状況の表示文言（例:「最新です（3510語）」）が出るまで待つ。
  await page.waitForSelector('.search-status', { timeout: 20_000 });
}

async function freezeTimeAndAnimations(page: Page): Promise<void> {
  await page.clock.install({ time: new Date('2026-08-01T09:00:00Z') });
  await page.addStyleTag({
    content: `*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; }`,
  });
}

export const test = base.extend<{ preparedPage: Page }>({
  preparedPage: async ({ page }, use) => {
    await resetIndexedDb(page);
    await mockAiProviders(page);
    await page.goto('/');
    await freezeTimeAndAnimations(page);
    await page.waitForFunction(() => document.fonts.ready.then(() => true), { timeout: 10_000 }).catch(() => {
      // フォント読み込みが10秒で終わらない場合はテスト続行し、観点として別途報告する。
    });
    await waitForSeedSettled(page);
    // この use は Playwright のフィクスチャ引数で、React Hooks の use ではない。
    // ルールが名前だけで誤検知するため、この行に限って抑制する。
    // eslint-disable-next-line react-hooks/rules-of-hooks
    await use(page);
  },
});

export { expect } from '@playwright/test';
