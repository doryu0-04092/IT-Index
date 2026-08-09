import { expect, test } from '@playwright/test';

/**
 * Phase 0のE2Eゲート骨格。ビルド→配信→描画の経路が通ることだけを固定する。
 * 機能のE2EはPhase 1で実装と同時に足す(docs/v2/architecture.md §9)。
 */
test('ビルドしたv2クライアントが描画される', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'IT-Index v2' })).toBeVisible();
  // sharedのnormalizeがビルドに含まれて動いていること(ワークスペース配線の確認)
  await expect(page.getByTestId('normalize-probe')).toHaveText('it用語いんでっくす');
});
