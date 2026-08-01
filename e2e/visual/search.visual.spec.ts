import { test, expect } from '../fixtures/base';

// @visual
// 判定器自身の決定性確認用の最小テスト。
// 「何も変更していない状態で2回実行し、同じ結果が出るか」を先に確認してから範囲を広げる。
test('検索画面（ライト）@visual', async ({ preparedPage: page }) => {
  await expect(page).toHaveScreenshot('search-light.png', { animations: 'disabled' });
});

test('検索画面（ダーク）@visual', async ({ preparedPage: page }) => {
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await expect(page).toHaveScreenshot('search-dark.png', { animations: 'disabled' });
});
