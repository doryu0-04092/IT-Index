import { test } from '@playwright/test';

test('focus behavior when opening SettingsModal', async ({ page }) => {
  await page.addInitScript(() => { indexedDB.deleteDatabase('it-index'); localStorage.clear(); });
  await page.goto('/');
  await page.waitForSelector('.search-status', { timeout: 20000 });
  const closeBtn = page.locator('.onboarding-content .dismiss-error');
  if (await closeBtn.count()) await closeBtn.click();

  await page.getByText('設定', { exact: true }).click();
  await page.waitForSelector('.modal-content');
  const active = await page.evaluate(() => {
    const el = document.activeElement;
    return el ? { tag: el.tagName, cls: el.className, text: el.textContent } : null;
  });
  console.log('Active element right after opening modal:', JSON.stringify(active));

  // Escapeキーで閉じるか
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  console.log('Modal still present after Escape:', await page.locator('.modal-content').count());

  // Tabで背景要素に抜けられるか（フォーカストラップの有無）
  if (await page.locator('.modal-content').count() === 0) {
    // Escapeで閉じてしまった場合は再度開く
    await page.getByText('設定', { exact: true }).click();
    await page.waitForSelector('.modal-content');
  }
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press('Tab');
  }
  const activeAfterTabs = await page.evaluate(() => {
    const el = document.activeElement;
    const overlay = document.querySelector('.modal-overlay');
    const insideModal = overlay ? overlay.contains(el) : null;
    return el ? { tag: el.tagName, cls: el.className, text: (el.textContent||'').slice(0,20), insideModal } : null;
  });
  console.log('Active element after 15 Tabs:', JSON.stringify(activeAfterTabs));
});
