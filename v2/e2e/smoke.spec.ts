import { expect, type Page, test } from '@playwright/test';

/**
 * v2クライアントのスモークE2E。要件定義書§4.1「残す」機能の入口が実ビルド上で通ることを
 * 固定する(docs/v2/architecture.md §9)。workers:1・IndexedDB共有前提(playwright.config.ts)
 * のため、複数testが同じシード取り込み結果を前提にしてよい。
 */

/**
 * 初回起動時のオンボーディングモーダル(lib/OnboardingModal.tsx)は表示中
 * modal-overlayが画面全体のクリックを奪う。実ブラウザ(jsdomと異なりhit-testingが働く)
 * ではこれを閉じないと以降の操作がすべてタイムアウトするため、各testの冒頭で閉じる。
 * 「スキップ」はステップに関わらず即座に閉じる(次回から表示しないonにする必要は無い
 * ——このtest実行のIndexedDB/localStorageは使い捨てのため既読状態の持ち越しは問わない)。
 */
async function dismissOnboarding(page: Page) {
  const skip = page.getByText('スキップ');
  if (await skip.isVisible().catch(() => false)) {
    await skip.click();
  }
}

test('ビルドしたv2クライアントが描画され、単一UIでナビゲーションが機能する', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'IT-Index v2' })).toBeVisible();
  await dismissOnboarding(page);
  // シード取り込み(実際のpublic/seed/terms.jsonがfetchされ、登録単語数が0件から増える)
  await expect(page.getByText(/登録単語数\(\d+語\)/)).toBeVisible({ timeout: 15_000 });
});

test('シード取り込み後に検索して結果から用語詳細を開ける', async ({ page }) => {
  await page.goto('/');
  await dismissOnboarding(page);
  await expect(page.getByText(/登録単語数\(\d+語\)/)).toBeVisible({ timeout: 15_000 });

  await page.getByRole('combobox', { name: '用語を検索' }).fill('TCP/IP');
  const result = page.getByRole('option', { name: 'TCP/IP ティーシーピーアイピー ネットワーク' });
  await expect(result).toBeVisible();
  await result.click();

  await expect(page.getByRole('heading', { name: 'TCP/IP ティーシーピーアイピー' })).toBeVisible();
  await expect(page.getByText('ネットワーク')).toBeVisible();

  // 戻ると検索画面に戻り、入力欄が復元されている(検索から開いた場合の戻り先は検索の1つだけ)
  await page.getByText('← 戻る').click();
  await expect(page.getByRole('combobox', { name: '用語を検索' })).toBeVisible();
});

test('索引タブと履歴タブに切り替えられる', async ({ page }) => {
  await page.goto('/');
  await dismissOnboarding(page);
  await expect(page.getByText(/登録単語数\(\d+語\)/)).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: '索引' }).click();
  await expect(page.getByRole('heading', { name: 'A', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '五十音へジャンプ' })).toBeVisible();

  await page.getByRole('button', { name: '履歴' }).click();
  await expect(page.getByRole('button', { name: '時系列' })).toHaveAttribute('aria-current', 'page');

  // サブタブ切替(時系列→重み付け)
  await page.getByRole('button', { name: '重み付け' }).click();
  await expect(page.getByText('最近も繰り返し聞いている語ほど上位')).toBeVisible();
});
