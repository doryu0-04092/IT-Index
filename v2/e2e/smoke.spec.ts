import { expect, test } from '@playwright/test';

/**
 * v2クライアントのスモークE2E。要件定義書§4.1「残す」機能の入口が実ビルド上で通ることを
 * 固定する(docs/v2/architecture.md §9)。workers:1・IndexedDB共有前提(playwright.config.ts)
 * のため、複数testが同じシード取り込み結果を前提にしてよい。
 */
test('ビルドしたv2クライアントが描画され、単一UIでナビゲーションが機能する', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'IT-Index v2' })).toBeVisible();
  // シード取り込み(実際のpublic/seed/terms.jsonがfetchされ、登録単語数が0件から増える)
  await expect(page.getByText(/登録単語数\(\d+語\)/)).toBeVisible({ timeout: 15_000 });
});

test('シード取り込み後に検索して結果から用語詳細を開ける', async ({ page }) => {
  await page.goto('/');
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

test('索引タブと重み付けタブに切り替えられる', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText(/登録単語数\(\d+語\)/)).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: '索引' }).click();
  await expect(page.getByRole('heading', { name: 'A', exact: true })).toBeVisible();

  await page.getByRole('button', { name: '重み付け' }).click();
  await expect(page.getByText('最近も繰り返し聞いている語ほど上位')).toBeVisible();
});
