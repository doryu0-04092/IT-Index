import { test, type Page } from '@playwright/test';
import * as fs from 'fs';

/**
 * キーボード操作・フォーカス管理・レスポンシブの調査用spec。
 * 検出/報告のみが目的。ソース変更はしない。
 */

const SHOT_DIR = 'docs/review/agents/screenshots/keyboard';

async function prepare(page: Page): Promise<void> {
  await page.addInitScript(() => {
    indexedDB.deleteDatabase('it-index');
    localStorage.clear();
  });
  await page.route('https://api.anthropic.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: 'モック応答です。' }] }) }),
  );
  // Playwrightのroute()は後から登録した方が優先されるため、より限定的なパターンは後で登録する
  await page.route('https://api.anthropic.com/v1/models**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ id: 'claude-mock-model' }] }) }),
  );
  await page.route('https://api.openai.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: 'モック応答です。' } }] }) }),
  );
  await page.route('https://generativelanguage.googleapis.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'モック応答です。' }] } }] }) }),
  );
  await page.goto('/');
  await page.addStyleTag({
    content: `*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; }`,
  });
  await page.waitForSelector('.search-status', { timeout: 20_000 });
  // オンボーディングモーダルを閉じる（別観点のため、ここでは単に閉じるだけ）
  const closeBtn = page.locator('.onboarding-content .dismiss-error');
  if (await closeBtn.count()) await closeBtn.click();
}

async function activeInfo(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return null;
    return {
      tag: el.tagName,
      cls: el.className,
      text: (el.textContent || '').trim().slice(0, 30),
      role: el.getAttribute('role'),
    };
  });
}

async function tabSequence(page: Page, count: number, label: string) {
  const seq: unknown[] = [];
  for (let i = 0; i < count; i++) {
    await page.keyboard.press('Tab');
    seq.push(await activeInfo(page));
  }
  console.log(`=== ${label} ===`);
  for (const [i, s] of seq.entries()) console.log(`Tab ${i + 1}:`, JSON.stringify(s));
  return seq;
}

test('search screen tab order (with query typed)', async ({ page }) => {
  await prepare(page);
  await page.locator('.search-input').fill('ネットワーク');
  await page.waitForTimeout(300);
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await tabSequence(page, 15, 'search-with-query');
  await page.screenshot({ path: `${SHOT_DIR}/search-tab-start.png` });
});

test('search screen: arrow key navigation in results (check if supported)', async ({ page }) => {
  await prepare(page);
  const input = page.locator('.search-input');
  await input.fill('ネットワーク');
  await input.waitFor();
  await page.waitForTimeout(300);
  await input.focus();
  const beforeActive = await activeInfo(page);
  await page.keyboard.press('ArrowDown');
  const afterDown = await activeInfo(page);
  await page.keyboard.press('ArrowDown');
  const afterDown2 = await activeInfo(page);
  console.log('arrow-nav before:', JSON.stringify(beforeActive));
  console.log('arrow-nav afterDown:', JSON.stringify(afterDown));
  console.log('arrow-nav afterDown2:', JSON.stringify(afterDown2));
});

test('detail screen tab order', async ({ page }) => {
  await prepare(page);
  await page.locator('.search-input').fill('ネットワーク');
  await page.waitForTimeout(300);
  const firstResult = page.locator('.search-result').first();
  await firstResult.click();
  await page.waitForSelector('.chat-screen, [class*="detail"]', { timeout: 10_000 }).catch(() => {});
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await tabSequence(page, 10, 'detail-screen');
  await page.screenshot({ path: `${SHOT_DIR}/detail-tab-start.png` });
});

async function satisfyApiKeyPromptIfShown(page: Page): Promise<void> {
  const prompt = page.locator('.api-key-prompt');
  if ((await prompt.count()) === 0) return;
  await page.locator('.api-key-prompt input[type="password"]').fill('sk-mock-key-for-investigation');
  await page.locator('.api-key-prompt button[type="submit"]').click();
  await page.waitForSelector('.api-key-prompt .search-status', { timeout: 10_000 });
  await page.locator('.api-key-prompt button[type="submit"]').click();
  await page.waitForSelector('.api-key-prompt', { state: 'detached', timeout: 10_000 });
}

test('chat screen (free) tab order + quick asks + subject row + commit + TermPicker', async ({ page }) => {
  await prepare(page);
  await page.getByText('自由に質問', { exact: true }).click();
  await page.waitForSelector('.chat-screen, .api-key-prompt', { timeout: 10_000 });
  await satisfyApiKeyPromptIfShown(page);
  await page.waitForSelector('.chat-screen', { timeout: 10_000 });
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await tabSequence(page, 12, 'chat-free-screen');
  await page.screenshot({ path: `${SHOT_DIR}/chat-tab-start.png` });

  // TermPicker（「用語を選ぶ」）を開いてキーボード操作を確認
  await page.getByText('用語を選ぶ', { exact: true }).click();
  await page.waitForSelector('.term-picker', { timeout: 5_000 });
  await page.screenshot({ path: `${SHOT_DIR}/term-picker-open.png` });

  // 入力欄にautoFocusがあるか確認
  const activeAtOpen = await activeInfo(page);
  console.log('TermPicker activeElement at open:', JSON.stringify(activeAtOpen));

  await page.keyboard.type('ネットワーク');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOT_DIR}/term-picker-results.png` });

  // 矢印キーで候補一覧を辿れるか確認
  const beforeArrow = await activeInfo(page);
  await page.keyboard.press('ArrowDown');
  const afterArrow = await activeInfo(page);
  console.log('TermPicker arrow before:', JSON.stringify(beforeArrow));
  console.log('TermPicker arrow after:', JSON.stringify(afterArrow));

  // Tabで候補ボタンに到達できるか（何回で最初の候補ボタンに着くか）
  await page.locator('.term-picker input').focus();
  const tabSeq = await tabSequence(page, 6, 'term-picker-tab');

  // Enterキーで候補を選べるか（候補ボタンにフォーカスがある状態でEnter）
  const firstResultBtn = page.locator('.term-picker .search-result').first();
  await firstResultBtn.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const closedByEnter = (await page.locator('.term-picker').count()) === 0;
  console.log('TermPicker closed by Enter on result button:', closedByEnter);
  fs.writeFileSync(`${SHOT_DIR}/term-picker-tab-seq.json`, JSON.stringify(tabSeq, null, 2));
});

test('chat screen: full tab order through commit button + subject-row second button', async ({ page }) => {
  await prepare(page);
  await page.getByText('自由に質問', { exact: true }).click();
  await page.waitForSelector('.chat-screen, .api-key-prompt', { timeout: 10_000 });
  await satisfyApiKeyPromptIfShown(page);
  await page.waitForSelector('.chat-screen', { timeout: 10_000 });
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await tabSequence(page, 15, 'chat-free-full');
});

test('chat screen: tab order after sending a message (commit button becomes enabled)', async ({ page }) => {
  await prepare(page);
  await page.getByText('自由に質問', { exact: true }).click();
  await page.waitForSelector('.chat-screen, .api-key-prompt', { timeout: 10_000 });
  await satisfyApiKeyPromptIfShown(page);
  await page.waitForSelector('.chat-screen', { timeout: 10_000 });
  await page.locator('.chat-input-row textarea').fill('テスト質問');
  await page.locator('.chat-input-row button[type="button"]').click();
  await page.waitForSelector('.chat-message-assistant', { timeout: 10_000 });
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await tabSequence(page, 16, 'chat-free-with-message');
});

test('TermPicker: Escape key behavior', async ({ page }) => {
  await prepare(page);
  await page.getByText('自由に質問', { exact: true }).click();
  await page.waitForSelector('.chat-screen, .api-key-prompt', { timeout: 10_000 });
  await satisfyApiKeyPromptIfShown(page);
  await page.waitForSelector('.chat-screen', { timeout: 10_000 });
  await page.getByText('用語を選ぶ', { exact: true }).click();
  await page.waitForSelector('.term-picker', { timeout: 5_000 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const stillOpenAfterEscape = (await page.locator('.term-picker').count()) > 0;
  console.log('TermPicker still open after Escape:', stillOpenAfterEscape);
});

test('TermPicker: reaching cancel button requires tabbing through all matched results', async ({ page }) => {
  await prepare(page);
  await page.getByText('自由に質問', { exact: true }).click();
  await page.waitForSelector('.chat-screen, .api-key-prompt', { timeout: 10_000 });
  await satisfyApiKeyPromptIfShown(page);
  await page.waitForSelector('.chat-screen', { timeout: 10_000 });
  await page.getByText('用語を選ぶ', { exact: true }).click();
  await page.waitForSelector('.term-picker', { timeout: 5_000 });
  // 「ネ」1文字だけで検索すると大量にヒットする想定（かな1文字は多くの語に部分一致しうる）
  await page.keyboard.type('ネ');
  await page.waitForTimeout(300);
  const resultCount = await page.locator('.term-picker .search-result').count();
  console.log('TermPicker result count for query "ネ":', resultCount);
  let tabs = 0;
  let reachedCancel = false;
  for (let i = 0; i < resultCount + 3; i++) {
    await page.keyboard.press('Tab');
    tabs++;
    const info = await activeInfo(page);
    if (info && (info as { cls: string }).cls.includes('term-picker-cancel')) {
      reachedCancel = true;
      break;
    }
  }
  console.log(`TermPicker: reached cancel button after ${tabs} Tabs (resultCount=${resultCount}), reached=${reachedCancel}`);
});

test('history screen tab order + keyboard tab switching', async ({ page }) => {
  await prepare(page);
  await page.getByText('履歴', { exact: true }).click();
  await page.waitForSelector('.history-screen', { timeout: 10_000 });
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await tabSequence(page, 8, 'history-screen');
  await page.screenshot({ path: `${SHOT_DIR}/history-tab-start.png` });
});

test('focus ring visibility: btn-primary and top-nav-item.active (light+dark), via real Tab key', async ({ page }) => {
  await prepare(page);
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});

    // Tab1 = 「フォルダを作成」(btn-primary) を実際のキー操作で辿る
    await page.keyboard.press('Tab');
    const onPrimary = await activeInfo(page);
    console.log(`focusring ${theme} Tab1 (expect btn-primary):`, JSON.stringify(onPrimary));
    await page.screenshot({ path: `${SHOT_DIR}/focusring-btnprimary-${theme}.png` });

    // Tab2 = 「後で設定する」、Tab3 = top-nav「検索」(active)
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const onTopNavActive = await activeInfo(page);
    console.log(`focusring ${theme} Tab3 (expect top-nav-item active):`, JSON.stringify(onTopNavActive));
    await page.screenshot({ path: `${SHOT_DIR}/focusring-topnav-active-${theme}.png` });
  }
});

test('focus ring: compare .focus() (script) vs real Tab keypress on same button', async ({ page }) => {
  await prepare(page);
  const btn = page.locator('.btn-primary').first();
  await btn.focus();
  await page.screenshot({ path: `${SHOT_DIR}/focusring-compare-scriptfocus.png` });
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('Tab');
  await page.screenshot({ path: `${SHOT_DIR}/focusring-compare-tabkey.png` });
  const outlineViaScript = await btn.evaluate((el) => getComputedStyle(el).outlineStyle);
  console.log('outlineStyle when focused via script .focus():', outlineViaScript);
});

test('viewport sweep: 1440/1024/768/375 on search/detail/chat', async ({ page }) => {
  await prepare(page);
  const viewports = [
    { w: 1440, h: 900, label: '1440' },
    { w: 1024, h: 800, label: '1024' },
    { w: 768, h: 900, label: '768' },
    { w: 375, h: 812, label: '375' },
  ];

  for (const vp of viewports) {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await page.waitForTimeout(150);
    // search
    await page.getByText('検索', { exact: true }).click().catch(() => {});
    await page.waitForTimeout(150);
    const scrollInfoSearch = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    console.log(`viewport ${vp.label} search scrollInfo:`, JSON.stringify(scrollInfoSearch));
    await page.screenshot({ path: `${SHOT_DIR}/viewport-${vp.label}-search.png`, fullPage: true });

    // detail
    await page.locator('.search-input').fill('ネットワーク');
    await page.waitForTimeout(300);
    const firstResult = page.locator('.search-result').first();
    if (await firstResult.count()) {
      await firstResult.click();
      await page.waitForTimeout(150);
      const scrollInfoDetail = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      console.log(`viewport ${vp.label} detail scrollInfo:`, JSON.stringify(scrollInfoDetail));
      await page.screenshot({ path: `${SHOT_DIR}/viewport-${vp.label}-detail.png`, fullPage: true });
      await page.getByText('← 検索に戻る').click().catch(() => {});
    }

    // chat
    await page.getByText('自由に質問', { exact: true }).click().catch(() => {});
    await page.waitForTimeout(150);
    await satisfyApiKeyPromptIfShown(page).catch(() => {});
    await page.waitForTimeout(150);
    const scrollInfoChat = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    console.log(`viewport ${vp.label} chat scrollInfo:`, JSON.stringify(scrollInfoChat));
    await page.screenshot({ path: `${SHOT_DIR}/viewport-${vp.label}-chat.png`, fullPage: true });
  }
});

test('200% zoom equivalent reflow check (WCAG 1.4.10)', async ({ page }) => {
  await prepare(page);
  // 1280x1024の実windowで200%ズームは、CSS px換算で640x512相当のビューポートになる
  await page.setViewportSize({ width: 640, height: 512 });
  await page.waitForTimeout(150);
  const scrollInfo = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
  console.log('zoom-equivalent(640x512) search scrollInfo:', JSON.stringify(scrollInfo));
  await page.screenshot({ path: `${SHOT_DIR}/zoom200-search.png`, fullPage: true });

  await page.locator('.search-input').fill('ネットワーク');
  await page.waitForTimeout(300);
  const firstResult = page.locator('.search-result').first();
  await firstResult.click();
  await page.waitForTimeout(150);
  const scrollInfoDetail = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  console.log('zoom-equivalent(640x512) detail scrollInfo:', JSON.stringify(scrollInfoDetail));
  await page.screenshot({ path: `${SHOT_DIR}/zoom200-detail.png`, fullPage: true });
});
