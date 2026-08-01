import { test } from '@playwright/test';

test('focus step by step', async ({ page }) => {
  await page.addInitScript(() => { indexedDB.deleteDatabase('it-index'); localStorage.clear(); });
  await page.goto('/');
  await page.waitForSelector('.search-status', { timeout: 20000 });
  const closeBtn = page.locator('.onboarding-content .dismiss-error');
  if (await closeBtn.count()) await closeBtn.click();
  await page.getByText('設定', { exact: true }).click();
  await page.waitForSelector('.modal-content');
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Tab');
    const active = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? { tag: el.tagName, cls: el.className, text: (el.textContent||'').slice(0,25) } : null;
    });
    console.log(`Tab ${i+1}:`, JSON.stringify(active));
  }
});
