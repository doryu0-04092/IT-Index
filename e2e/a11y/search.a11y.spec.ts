import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '../fixtures/base';

// Stage Bのゲート一括実行用の最小a11yテスト。詳細な全画面検証はStage Cのエージェント1が担当する。
test('検索画面に critical/serious 違反が無い', async ({ preparedPage: page }) => {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const blocking = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  expect(blocking).toEqual([]);
});
