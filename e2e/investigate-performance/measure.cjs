// 調査用の一時スクリプト。Playwright test runnerのwebServer(4173)と競合しないよう、
// 自前で起動したvite preview(4176)に対してchromiumを直接操作する。
// 実行: node e2e/investigate-performance/measure.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'http://localhost:4176';
const SHOT_DIR = path.join(__dirname, '..', '..', 'docs', 'review', 'agents', 'screenshots', 'performance');
const LOG_PATH = path.join(SHOT_DIR, 'measure-log.json');

const results = {};

async function mockAiProviders(page) {
  await page.route('https://api.anthropic.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: 'モック応答です。' }] }) })
  );
  await page.route('https://api.openai.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: 'モック応答です。' } }] }) })
  );
  await page.route('https://generativelanguage.googleapis.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'モック応答です。' }] } }] }) })
  );
}

async function dismissOnboardingIfPresent(page) {
  const skipBtn = page.getByRole('button', { name: 'スキップ' });
  if (await skipBtn.isVisible().catch(() => false)) {
    await skipBtn.click();
  }
}

async function measureSeedImport(browser, runIndex) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(() => indexedDB.deleteDatabase('it-index'));
  await mockAiProviders(page);

  const t0 = Date.now();
  await page.goto(BASE_URL + '/');
  await page.waitForSelector('.search-status', { timeout: 20_000 });

  // .search-statusのテキストが「読み込み中」系から「登録単語数」表示に変わるまで待つ
  await page.waitForFunction(() => {
    const el = document.querySelector('.search-status');
    return !!el && el.textContent && el.textContent.includes('登録単語数');
  }, { timeout: 30_000 });
  const t1 = Date.now();

  const finalText = await page.locator('.search-status').innerText();

  // performance API側からも navigation timing を取る（参考値）
  const perf = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    return nav ? { domContentLoaded: nav.domContentLoadedEventEnd, loadEvent: nav.loadEventEnd } : null;
  });

  await context.close();
  return { runIndex, wallMs: t1 - t0, finalText, perf };
}

async function measureSearchLatency(browser, iterations) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(() => indexedDB.deleteDatabase('it-index'));
  await mockAiProviders(page);
  await page.goto(BASE_URL + '/');
  await page.waitForFunction(() => {
    const el = document.querySelector('.search-status');
    return !!el && el.textContent && el.textContent.includes('登録単語数');
  }, { timeout: 30_000 });
  await dismissOnboardingIfPresent(page);

  const input = page.locator('.search-input');
  const queries = ['セ', 'キュ', 'リティ', 'API', 'ネットワーク']; // 文字を積み増していくケースを複数試す

  const perKey = [];

  for (const q of queries) {
    await input.fill('');
    await page.waitForTimeout(400); // 前のdebounce/再描画を収める

    // 1文字ずつ入力し、各文字ごとに「キー入力タイムスタンプ」→「結果DOM更新タイムスタンプ」を計測
    let typed = '';
    for (const ch of q) {
      typed += ch;
      const keyTs = await page.evaluate(() => performance.now());
      await input.pressSequentially(ch, { delay: 0 });

      // 結果リスト、または「0件」相当のstatusが更新されるのを監視するため、
      // MutationObserverをresultsコンテナに仕込んでdebounce+再描画完了を検知する
      const updateTs = await page.evaluate((keyTsInner) => {
        return new Promise((resolve) => {
          const target = document.querySelector('.search-results');
          if (!target) return resolve(performance.now());
          const observer = new MutationObserver(() => {
            observer.disconnect();
            resolve(performance.now());
          });
          observer.observe(target, { childList: true, subtree: true });
          // 変化がない(結果件数が変わらない)場合のフォールバックタイムアウト
          setTimeout(() => {
            observer.disconnect();
            resolve(performance.now());
          }, 2000);
        });
      }, keyTs);

      perKey.push({ query: typed, delayMs: Math.round(updateTs - keyTs) });
    }
  }

  await context.close();
  return perKey;
}

async function measureFontsAndPaint(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(() => indexedDB.deleteDatabase('it-index'));
  await mockAiProviders(page);

  await page.evaluate(() => {
    // 何もしない: gotoの前にPerformanceObserverを仕込みたいのでaddInitScriptを使う
  });
  await page.addInitScript(() => {
    window.__layoutShifts = [];
    try {
      const po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__layoutShifts.push({ value: entry.value, startTime: entry.startTime, hadRecentInput: entry.hadRecentInput });
        }
      });
      po.observe({ type: 'layout-shift', buffered: true });
    } catch (e) {
      window.__layoutShiftsError = String(e);
    }
  });

  await page.goto(BASE_URL + '/');
  await page.waitForFunction(() => {
    const el = document.querySelector('.search-status');
    return !!el && el.textContent && el.textContent.includes('登録単語数');
  }, { timeout: 30_000 });
  await page.waitForTimeout(1000); // フォント読み込み・レイアウトシフトが収まるのを待つ

  const data = await page.evaluate(() => {
    const paintEntries = performance.getEntriesByType('paint').map((e) => ({ name: e.name, startTime: e.startTime }));
    return {
      paintEntries,
      fontsReadyChecked: true,
      layoutShifts: window.__layoutShifts || [],
      layoutShiftsError: window.__layoutShiftsError || null,
      clsTotal: (window.__layoutShifts || []).filter((s) => !s.hadRecentInput).reduce((a, s) => a + s.value, 0),
    };
  });

  // document.fonts.readyのタイミングをfirst-paintと比較するため、別途fonts.readyの解決時刻を取得
  const fontsReadyTime = await page.evaluate(() => {
    return document.fonts.ready.then(() => performance.now());
  });

  await page.screenshot({ path: path.join(SHOT_DIR, 'fonts-fout-check.png') });

  await context.close();
  return { ...data, fontsReadyTime };
}

async function measureDetailTransition(browser, iterations) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(() => indexedDB.deleteDatabase('it-index'));
  await mockAiProviders(page);
  await page.goto(BASE_URL + '/');
  await page.waitForFunction(() => {
    const el = document.querySelector('.search-status');
    return !!el && el.textContent && el.textContent.includes('登録単語数');
  }, { timeout: 30_000 });
  await dismissOnboardingIfPresent(page);

  const timings = [];
  for (let i = 0; i < iterations; i++) {
    await page.locator('.search-input').fill('');
    await page.waitForTimeout(200);
    await page.locator('.search-input').fill('セキュリティ');
    await page.waitForTimeout(400);
    const firstResult = page.locator('.search-result').first();
    await firstResult.waitFor({ state: 'visible', timeout: 5000 });

    const clickTs = await page.evaluate(() => performance.now());
    await firstResult.click();

    const renderTs = await page.evaluate(() => {
      return new Promise((resolve) => {
        // term-detail内の見出し(h2)が実データで埋まるのを待つ(Skeleton終了)
        const check = () => {
          const h2 = document.querySelector('.term-detail h2');
          if (h2 && h2.textContent && h2.textContent.trim().length > 0) {
            resolve(performance.now());
            return true;
          }
          return false;
        };
        if (check()) return;
        const observer = new MutationObserver(() => {
          if (check()) observer.disconnect();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => {
          observer.disconnect();
          resolve(performance.now());
        }, 3000);
      });
    });

    timings.push(Math.round(renderTs - clickTs));

    // 戻る
    await page.locator('.term-detail-back').click();
    await page.waitForSelector('.search-screen', { timeout: 5000 });
  }

  await context.close();
  return timings;
}

(async () => {
  const browser = await chromium.launch();

  console.log('=== 1. シード取り込み時間（3回） ===');
  const seedRuns = [];
  for (let i = 1; i <= 3; i++) {
    const r = await measureSeedImport(browser, i);
    console.log(JSON.stringify(r));
    seedRuns.push(r);
  }
  results.seedImport = seedRuns;

  console.log('=== 2. 検索入力→再描画レイテンシ ===');
  const searchLatency = await measureSearchLatency(browser, 1);
  console.log(JSON.stringify(searchLatency));
  results.searchLatency = searchLatency;

  console.log('=== 3. フォント読み込み/CLS ===');
  const fonts = await measureFontsAndPaint(browser);
  console.log(JSON.stringify(fonts));
  results.fonts = fonts;

  console.log('=== 5. 詳細画面遷移レイテンシ（5回） ===');
  const detailTimings = await measureDetailTransition(browser, 5);
  console.log(JSON.stringify(detailTimings));
  results.detailTransition = detailTimings;

  await browser.close();

  fs.writeFileSync(LOG_PATH, JSON.stringify(results, null, 2), 'utf-8');
  console.log('written to', LOG_PATH);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
