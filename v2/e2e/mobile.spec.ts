import { expect, type Page, test } from '@playwright/test';

/**
 * モバイル幅(390x844。iPhone 12相当)のスモークE2E(PR-R§4)。下部固定タブバーへの
 * 切り替え(App.css @media (max-width: 719.98px))が実ビルド上で機能することを固定する。
 * 既存のsmoke.spec.ts(デスクトップ1440x900、playwright.config.tsのuse.viewport既定)は
 * そのまま維持し、ここではtest.use()でこのファイルだけviewportを上書きする
 * (projects追加より変更が小さいシンプルな方を採用)。
 */
test.use({ viewport: { width: 390, height: 844 } });

/** smoke.spec.tsと同じ理由(実ブラウザでは初回起動時のオンボーディングモーダルを閉じないと
 * 以降の操作がタイムアウトする)でここでも複製する。 */
async function dismissOnboarding(page: Page) {
  const skip = page.getByText('スキップ');
  if (await skip.isVisible().catch(() => false)) {
    await skip.click();
  }
}

test('モバイル幅で下部固定タブバーが表示され、5タブすべてに遷移できる', async ({ page }) => {
  await page.goto('/');
  await dismissOnboarding(page);
  await expect(page.getByText(/登録単語数\(\d+語\)/)).toBeVisible({ timeout: 15_000 });

  const nav = page.getByRole('navigation', { name: '画面切り替え' });
  await expect(nav).toBeVisible();

  // 画面下端に固定されていること(下部タブバー化の確認。多少の誤差を許容する)
  const viewportSize = page.viewportSize();
  const navBox = await nav.boundingBox();
  expect(navBox).not.toBeNull();
  if (navBox && viewportSize) {
    expect(navBox.y + navBox.height).toBeGreaterThan(viewportSize.height - 10);
  }

  await expect(page.getByRole('button', { name: '検索', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '索引', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '履歴', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '設定', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '同期', exact: true })).toBeVisible();

  await page.getByRole('button', { name: '索引', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A', exact: true })).toBeVisible();
  await expect(nav).toBeVisible();

  await page.getByRole('button', { name: '履歴', exact: true }).click();
  await expect(page.getByRole('button', { name: '時系列' })).toHaveAttribute('aria-current', 'page');
  await expect(nav).toBeVisible();

  await page.getByRole('button', { name: '設定', exact: true }).click();
  await expect(page.getByRole('button', { name: '設定', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: 'ライセンス' })).toBeVisible();
  await expect(nav).toBeVisible();

  await page.getByRole('button', { name: '同期', exact: true }).click();
  await expect(page.getByLabel('メールアドレス')).toBeVisible();
  await expect(nav).toBeVisible();

  await page.getByRole('button', { name: '検索', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '用語を検索' })).toBeVisible();
  await expect(nav).toBeVisible();
});

test('モバイル幅で検索して結果から用語詳細を開ける', async ({ page }) => {
  await page.goto('/');
  await dismissOnboarding(page);
  await expect(page.getByText(/登録単語数\(\d+語\)/)).toBeVisible({ timeout: 15_000 });

  await page.getByRole('combobox', { name: '用語を検索' }).fill('TCP/IP');
  const result = page.getByRole('option', { name: 'TCP/IP ティーシーピーアイピー ネットワーク' });
  await expect(result).toBeVisible();
  await result.click();

  await expect(page.getByRole('heading', { name: 'TCP/IP ティーシーピーアイピー' })).toBeVisible();
  await expect(page.getByText('ネットワーク')).toBeVisible();
  // 下部タブバーは検索→詳細と遷移しても表示され続ける
  await expect(page.getByRole('navigation', { name: '画面切り替え' })).toBeVisible();
});
