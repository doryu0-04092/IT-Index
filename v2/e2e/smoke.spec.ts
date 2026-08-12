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

test('チャットを開いてすぐ戻ると、検索画面の「取り込み待ち」に出ない(v1 SearchScreen.tsx:93「まだ何もやり取りしていないセッションは表示不要」)', async ({ page }) => {
  await page.goto('/');
  await dismissOnboarding(page);
  await expect(page.getByText(/登録単語数\(\d+語\)/)).toBeVisible({ timeout: 15_000 });

  await page.getByRole('combobox', { name: '用語を検索' }).fill('TCP/IP');
  await page.getByRole('option', { name: 'TCP/IP ティーシーピーアイピー ネットワーク' }).click();
  await expect(page.getByRole('heading', { name: 'TCP/IP ティーシーピーアイピー' })).toBeVisible();

  // 「AIに聞く」でチャットセッションが作られるが、送信せずに即座に戻る
  await page.getByRole('button', { name: 'AIに聞く' }).click();
  await expect(page.getByText('← 戻る').first()).toBeVisible();
  await page.getByText('← 戻る').first().click();

  // 単語詳細から検索へ戻る
  await page.getByText('← 戻る').click();
  await expect(page.getByRole('combobox', { name: '用語を検索' })).toBeVisible();

  // messages.length===0のセッションは除外され、「取り込み待ち」自体が出ない
  await expect(page.getByText(/単語帳への取り込み待ち/)).toHaveCount(0);
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

test('設定タブに切り替えられ、ライセンス・AI設定・接続先サーバー・表示・データの5セクションが並ぶ', async ({ page }) => {
  await page.goto('/');
  await dismissOnboarding(page);
  await expect(page.getByText(/登録単語数\(\d+語\)/)).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: '設定', exact: true }).click();
  await expect(page.getByRole('button', { name: '設定', exact: true })).toHaveAttribute('aria-current', 'page');

  await expect(page.getByRole('heading', { name: 'ライセンス' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'AI設定' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '接続先サーバー' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '表示' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'データ' })).toBeVisible();

  // 未ログインでは同期タブ(AI設定・テーマは移設済みでここには無い)への誘導が出る
  await expect(page.getByText('ライセンスの購入にはログインが必要です。')).toBeVisible();

  await page.getByRole('button', { name: '同期', exact: true }).click();
  await expect(page.getByLabel('メールアドレス')).toBeVisible();
});
