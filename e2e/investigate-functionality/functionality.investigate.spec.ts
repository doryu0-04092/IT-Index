import { test, expect, type Page } from '@playwright/test';

/**
 * 機能性・エッジケース観点の調査用スペック（一時ファイル）。
 * ソースコードは一切変更しない。修正も行わない。
 */

const SHOT_DIR = 'docs/review/agents/screenshots/functionality';

async function resetIndexedDb(page: Page): Promise<void> {
  await page.addInitScript(() => {
    indexedDB.deleteDatabase('it-index');
  });
}

async function mockAiProviders(page: Page): Promise<void> {
  await page.route('https://api.anthropic.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ content: [{ type: 'text', text: 'モック応答です。' }] }),
    }),
  );
}

async function waitForSeedSettled(page: Page): Promise<void> {
  await page.waitForSelector('.search-status', { timeout: 20_000 });
}

async function dismissOnboardingIfPresent(page: Page) {
  const skipBtn = page.getByRole('button', { name: 'スキップ' });
  if (await skipBtn.isVisible().catch(() => false)) {
    await skipBtn.click();
  }
}

test.describe('機能性・エッジケース調査', () => {
  test('Q1: 検索品質の実測（実データ3510語）', async ({ page }) => {
    await resetIndexedDb(page);
    await page.goto('/');
    await waitForSeedSettled(page);
    await dismissOnboardingIfPresent(page);

    const queries: Array<[string, string]> = [
      ['api', 'API'],
      ['えーぴーあい', 'API'],
      ['さーば', 'サーバ'],
      ['さーばー', 'サーバ'],
      ['tcp/ip', 'TCP/IP'],
      ['tcpip', 'TCP/IP'],
      ['tcp/pi', 'TCP/IP'], // タイプミス想定
      ['三層', '3層'], // 漢数字 vs 半角数字（要件定義書§5.1の例そのもの）
      ['3層', '3層'],
      ['えすきゅーえる', 'SQL'],
      ['しーくえる', 'SQL'], // 非代表的な読み（要件上は英字直接入力に誘導する設計）
      ['sql', 'SQL'],
      ['でーたべーす', 'データベース'],
      ['るーてぃんぐ', 'ルーティング'],
      ['ろーどばらんさ', 'ロードバランサ'],
      ['どめいん', 'ドメイン'],
      ['dns', 'DNS'],
      ['きゃっしゅ', 'キャッシュ'],
      ['ばーじょん', 'バージョン'],
      ['あるごりずむ', 'アルゴリズム'],
      ['あるごりづむ', 'アルゴリズム'], // タイプミス
      ['十進数', '10進数'], // 漢数字
      ['二進数', '2進数'],
      ['二分木', '2分木'],
      ['ねっとわーく', 'ネットワーク'],
      ['ういるす', 'ウイルス'],
      ['ふぁいあうぉーる', 'ファイアウォール'],
      ['じょうちょうか', '冗長'], // 部分一致でも可
    ];

    const rows: string[] = [];
    for (const [q] of queries) {
      await page.locator('.search-input').fill('');
      await page.locator('.search-input').fill(q);
      await page.waitForTimeout(300);
      const results = await page.locator('.search-result-term').allInnerTexts();
      rows.push(`${q} => [${results.slice(0, 8).join(', ')}]`);
    }
    console.log('=== SEARCH QUALITY RESULTS ===');
    console.log(rows.join('\n'));

    // 「三層」は0件になることを実機で確認するための明示アサーション（証拠用）
    await page.locator('.search-input').fill('');
    await page.locator('.search-input').fill('三層');
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOT_DIR}/q1-sanso-zero-results.png` });
    const sansoCount = await page.locator('.search-result').count();
    console.log('三層 の結果件数:', sansoCount);
  });

  test('Q2: 空状態（履歴0件・検索0件）', async ({ page }) => {
    await resetIndexedDb(page);
    await page.goto('/');
    await waitForSeedSettled(page);
    await dismissOnboardingIfPresent(page);

    // 履歴: 重み付けビュー・時系列ビュー（0件）
    await page.getByRole('button', { name: '重み付けビュー' }).click();
    await expect(page.locator('.history-screen')).toBeVisible();
    await page.screenshot({ path: `${SHOT_DIR}/q2-history-weighted-empty.png` });

    await page.locator('.history-tabs button', { hasText: '時系列ビュー' }).click();
    await page.screenshot({ path: `${SHOT_DIR}/q2-history-timeline-empty.png` });

    await page.getByRole('button', { name: '検索', exact: true }).click();
    await expect(page.locator('.search-screen')).toBeVisible({ timeout: 10_000 });

    // 検索0件の実クエリ探索: 完全なランダム文字列・記号のみ・極端な長文
    const zeroCandidates = ['三層', 'ｚｚｚｚｚ@@@', '．．．．．', 'qwertyuiopasdfghjklzxcvbnm12345', '　　'];
    for (const q of zeroCandidates) {
      await page.locator('.search-input').fill('');
      await page.locator('.search-input').fill(q);
      await page.waitForTimeout(300);
      const count = await page.locator('.search-result').count();
      console.log(`zero-candidate "${q}" => ${count} 件`);
      if (count === 0) {
        await page.screenshot({ path: `${SHOT_DIR}/q2-search-zero-${encodeURIComponent(q)}.png` });
      }
    }
  });

  test('Q3: Mermaid図の表示（AI補足に図を持たせて確認）', async ({ page }) => {
    page.on('console', (m) => console.log('[browser]', m.text()));
    page.on('requestfailed', (r) => console.log('[requestfailed]', r.url(), r.failure()?.errorText));
    await resetIndexedDb(page);

    // 分配統合のAI応答をシステムプロンプトの一部で判定し、diagramsを含む結果を返す
    await page.route('https://api.anthropic.com/v1/messages', async (route) => {
      const body = route.request().postDataJSON() as { system?: string };
      const system = body.system ?? '';
      console.log('[route] system prompt head:', system.slice(0, 40));
      if (system.includes('話題に上ったIT用語ごとに情報を切り分けます')) {
        // 分配統合（DISTRIBUTION_SYSTEM_PROMPT）
        const payload = [
          {
            term: 'API',
            isTerm: true,
            askedByUser: true,
            summary: 'テスト用の要約',
            readings: ['エーピーアイ'],
            field: 'ソフトウェア',
            draftBody: 'APIはプログラム同士が情報をやり取りするための取り決め。呼び出す側と提供する側で約束事を決めておくことで、内部実装を知らなくても利用できる。',
            diagrams: ['graph TD;\n  Client-->|リクエスト|API;\n  API-->|レスポンス|Client;'],
          },
        ];
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(payload) }] }),
        });
        return;
      }
      // 通常のチャット応答
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ content: [{ type: 'text', text: 'モック応答です。' }] }),
      });
    });
    await page.route('https://api.anthropic.com/v1/models', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [{ id: 'claude-3-5-sonnet-mock' }] }),
      }),
    );

    await page.goto('/');
    await waitForSeedSettled(page);
    await dismissOnboardingIfPresent(page);

    await page.locator('.search-input').fill('API');
    await page.waitForTimeout(300);
    await page.locator('.search-result').first().click();
    await expect(page.locator('.term-detail')).toBeVisible();

    await page.getByRole('button', { name: 'この語についてAIに聞く' }).click();
    await page.locator('.chat-screen, .api-key-prompt').first().waitFor({ state: 'visible', timeout: 10_000 });
    if (await page.locator('.api-key-prompt').isVisible()) {
      const scope = page.locator('.api-key-prompt');
      await scope.locator('input[type="password"]').fill('sk-ant-test-key-0000');
      await scope.getByRole('button', { name: '接続を確認' }).click();
      await expect(scope.getByRole('button', { name: '設定', exact: true })).toBeVisible({ timeout: 10_000 });
      await scope.getByRole('button', { name: '設定', exact: true }).click();
      await page.locator('.chat-screen').waitFor({ state: 'visible', timeout: 10_000 });
    }

    await page.locator('.chat-input-row textarea').fill('APIについて図で説明して');
    await page.getByRole('button', { name: '送信', exact: true }).click();
    await expect(page.locator('.chat-message-assistant')).toContainText('モック応答です', { timeout: 10_000 });

    await page.getByRole('button', { name: 'この会話を確定する' }).click();
    await expect(page.locator('.search-screen')).toBeVisible({ timeout: 5_000 });
    // commitOrchestratorはバックグラウンドで進むため、DB反映を待つ
    await page.waitForTimeout(1500);

    await page.locator('.search-input').fill('API');
    await page.waitForTimeout(300);
    await page.locator('.search-result').first().click();
    await expect(page.locator('.term-detail')).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOT_DIR}/q3-mermaid-raw-text.png`, fullPage: true });

    const diagramsBlock = page.locator('.term-detail-diagrams');
    const hasDiagrams = await diagramsBlock.isVisible().catch(() => false);
    console.log('diagrams block visible:', hasDiagrams);
    if (hasDiagrams) {
      console.log('diagrams block text:', await diagramsBlock.innerText());
    } else {
      console.log('note body text:', await page.locator('.term-detail-body').innerText().catch(() => '(取得失敗)'));
    }
  });

  test('Q4: 非対応ブラウザ(Safari相当)向けバナーの有無', async ({ page }) => {
    await resetIndexedDb(page);
    // iOS Safari相当のUser-Agentに偽装
    await page.setExtraHTTPHeaders({});
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'userAgent', {
        get: () =>
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      });
      Object.defineProperty(navigator, 'platform', { get: () => 'iPhone' });
      // File System Access API 非対応を模擬
      // @ts-expect-error test-only
      delete window.showDirectoryPicker;
    });
    await page.goto('/');
    await waitForSeedSettled(page);
    await dismissOnboardingIfPresent(page);
    await page.screenshot({ path: `${SHOT_DIR}/q4-ios-safari-uastring-no-banner.png`, fullPage: true });

    const bannerCandidates = await page.locator('body').innerText();
    const mentionsUnsupported = /safari|iphone|ipad|非対応|対応していません|サポート対象外/i.test(bannerCandidates);
    console.log('非対応バナーらしき文言が画面内に存在するか:', mentionsUnsupported);
  });

  test('Q5: isFolderSyncAvailable=false 時のフォールバックUI', async ({ page }) => {
    await resetIndexedDb(page);
    await page.addInitScript(() => {
      // @ts-expect-error test-only
      delete window.showDirectoryPicker;
    });
    await page.goto('/');
    await waitForSeedSettled(page);
    await dismissOnboardingIfPresent(page);

    // ヘッダーのフォルダ作成バナーが出ないことを確認（isFolderSyncAvailable()がfalseなら出ない設計）
    const headerBannerVisible = await page.locator('.auth-banner', { hasText: 'ローカルフォルダ' }).isVisible().catch(() => false);
    console.log('ヘッダーのフォルダ作成バナー表示:', headerBannerVisible);
    await page.screenshot({ path: `${SHOT_DIR}/q5-header-no-folder-banner.png` });

    // 設定画面「ローカルデータ」セクションのフォールバック文言を確認
    await page.getByRole('button', { name: '設定', exact: true }).click();
    await expect(page.locator('.modal-content')).toBeVisible();
    await page.screenshot({ path: `${SHOT_DIR}/q5-settings-localdata-fallback.png`, fullPage: true });
    const settingsText = await page.locator('.modal-content').innerText();
    console.log('設定画面「ローカルデータ」に案内文言があるか:', settingsText.includes('この環境では使えません'));
  });

  test('Q6: シード取り込み失敗時の挙動とリトライ手段', async ({ page }) => {
    await resetIndexedDb(page);
    await page.route('**/seed/terms.json', (route) => route.abort('failed'));
    await page.goto('/');
    // seedSettled後は.search-statusが出るはずなので、それを待つ（失敗時も出る想定）
    await page.waitForSelector('.search-status', { timeout: 20_000 });
    await dismissOnboardingIfPresent(page);
    await page.screenshot({ path: `${SHOT_DIR}/q6-seed-fetch-failed.png`, fullPage: true });

    const statusText = await page.locator('.search-status').first().innerText();
    console.log('シード取得失敗直後のsearch-status文言:', statusText);
    const errorText = await page.locator('.chat-error').allInnerTexts();
    console.log('エラー表示文言:', errorText);

    // 再試行導線（ボタン等）が画面内に存在するか探索
    const retryButtons = await page.getByRole('button').allInnerTexts();
    console.log('画面内の全ボタン文言:', retryButtons);

    // 検索欄に入力しても常に0件になることを確認（辞書が空のため）
    await page.locator('.search-input').fill('API');
    await page.waitForTimeout(300);
    const resultCount = await page.locator('.search-result').count();
    console.log('辞書空の状態でAPI検索した結果件数:', resultCount);
    await page.screenshot({ path: `${SHOT_DIR}/q6-search-with-empty-dict.png` });
  });
});
