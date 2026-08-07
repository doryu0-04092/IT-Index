import { test, expect, type Page, type BrowserContext } from '@playwright/test';

/**
 * 信頼性・データ整合性観点の調査用スペック（一時ファイル）。
 * ソースコードは一切変更しない。修正も行わない。
 * このconfigのbaseURLはhttp://localhost:4177（自分専用のvite previewポート）。
 * Q2（StrictMode二重effect確認）だけはhttp://localhost:4178（vite devサーバー、production buildではStrictModeの
 * 意図的な二重effect実行が発生しないため）を明示的に使う。
 */

const SHOT_DIR = 'docs/review/agents/screenshots/reliability';

async function resetIndexedDb(page: Page): Promise<void> {
  await page.addInitScript(() => {
    indexedDB.deleteDatabase('it-index');
  });
}

async function mockAiProviders(page: Page): Promise<void> {
  await page.route('https://api.anthropic.com/v1/messages', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ content: [{ type: 'text', text: 'モック応答です。' }] }),
    }),
  );
  await page.route('https://api.anthropic.com/v1/models', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: 'claude-3-5-sonnet-mock' }] }),
    }),
  );
}

async function waitForSeedSettled(page: Page): Promise<void> {
  await page.waitForSelector('.search-status', { timeout: 30_000 });
}

async function dismissOnboardingIfPresent(page: Page) {
  const skipBtn = page.getByRole('button', { name: 'スキップ' });
  if (await skipBtn.isVisible().catch(() => false)) {
    await skipBtn.click();
  }
}

async function connectApiKey(page: Page) {
  if (await page.locator('.api-key-prompt').isVisible().catch(() => false)) {
    const scope = page.locator('.api-key-prompt');
    await scope.locator('input[type="password"]').fill('sk-ant-test-key-0000');
    await scope.getByRole('button', { name: '接続を確認' }).click();
    await expect(scope.getByRole('button', { name: '設定', exact: true })).toBeVisible({ timeout: 10_000 });
    await scope.getByRole('button', { name: '設定', exact: true }).click();
  }
}

test.describe('信頼性・データ整合性 調査', () => {
  test('Q1: v1相当のIndexedDBからv3への実マイグレーション', async ({ page }) => {
    page.on('console', (m) => console.log('[browser]', m.text()));
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));

    // IndexedDB APIはabout:blankでは使えない(SecurityError)ため、アプリのオリジンへ遷移する必要がある。
    // ただし普通にgoto('/')すると、そのままアプリのDexieがDBをv3で新規作成してしまい、
    // 「v1相当のDBを人為的に作ってからv3コードで開く」という前提が壊れる（かつ、既存のDexie接続が
    // 開いたままだとdeleteDatabase()がblocked状態で止まる）。そこでアプリ本体のJSバンドルの実行を
    // 一時的に止めた状態でオリジンだけ確立し、その間にv1相当のDBを作る。
    await page.route('**/assets/*.js', (route) =>
      route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }),
    );
    await page.goto('/');

    // 1. まずv1相当のスキーマだけを持つ生のIndexedDBを作る（Dexie未経由。src/db.ts version(1)と同じ形）
    const v1Result = await page.evaluate(() => {
      return new Promise<{ ok: boolean; error?: string; storeNames: string[] }>((resolve) => {
        const delReq = indexedDB.deleteDatabase('it-index');
        delReq.onerror = () => resolve({ ok: false, error: 'delete failed: ' + String(delReq.error), storeNames: [] });
        delReq.onsuccess = () => {
        const req = indexedDB.open('it-index', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          const terms = db.createObjectStore('terms', { keyPath: 'id' });
          terms.createIndex('field', 'field');
          terms.createIndex('origin', 'origin');
          terms.createIndex('deletedAt', 'deletedAt');

          const notes = db.createObjectStore('notes', { keyPath: 'termId' });
          notes.createIndex('updatedAt', 'updatedAt');

          const asks = db.createObjectStore('asks', { keyPath: 'id' });
          asks.createIndex('termId', 'termId');
          asks.createIndex('sessionId', 'sessionId');
          asks.createIndex('[at+id]', ['at', 'id']);

          const chatSessions = db.createObjectStore('chatSessions', { keyPath: 'id' });
          chatSessions.createIndex('termId', 'termId');
          chatSessions.createIndex('status', 'status');
          chatSessions.createIndex('lastActiveAt', 'lastActiveAt');

          const chatMessages = db.createObjectStore('chatMessages', { keyPath: 'id' });
          chatMessages.createIndex('sessionId', 'sessionId');
          chatMessages.createIndex('at', 'at');

          db.createObjectStore('settings', { keyPath: 'key' });
        };
        req.onsuccess = () => {
          const db = req.result;
          const storeNames = Array.from(db.objectStoreNames);
          db.close();
          resolve({ ok: true, storeNames });
        };
        req.onerror = () => resolve({ ok: false, error: String(req.error), storeNames: [] });
        };
      });
    });
    console.log('v1相当DB作成結果:', JSON.stringify(v1Result));
    expect(v1Result.ok).toBe(true);
    expect(v1Result.storeNames.sort()).toEqual(['asks', 'chatMessages', 'chatSessions', 'notes', 'settings', 'terms']);

    // 2. アプリ（現行v3コード）を開かせ、Dexieによるマイグレーションを走らせる
    await page.unroute('**/assets/*.js');
    await mockAiProviders(page);
    await page.reload();
    await waitForSeedSettled(page);
    await dismissOnboardingIfPresent(page);
    await page.screenshot({ path: `${SHOT_DIR}/q1-after-open-v1-then-v3-app.png`, fullPage: true });

    // 3. マイグレーション後の実態を確認：バージョン番号・ストア構成・既存データの生存・新規ストアの利用可否
    const after = await page.evaluate(() => {
      return new Promise<{ version: number; storeNames: string[] }>((resolve, reject) => {
        const req = indexedDB.open('it-index');
        req.onsuccess = () => {
          const db = req.result;
          resolve({ version: db.version, storeNames: Array.from(db.objectStoreNames).sort() });
          db.close();
        };
        req.onerror = () => reject(req.error);
      });
    });
    console.log('マイグレーション後のDB状態:', JSON.stringify(after));

    // 検索が機能する(=terms storeが生きていてシードが入っている)ことを実地確認
    await page.locator('.search-input').fill('API');
    await page.waitForTimeout(300);
    const resultCount = await page.locator('.search-result').count();
    console.log('マイグレーション後の"API"検索結果件数:', resultCount);

    // 設定画面が開ける（keyStoreストアを使う機能）ことを確認。
    // 設定は2026-08-04にモーダルから通常の画面遷移へ変更した（.modal-content ではない）。
    await page.getByRole('button', { name: '設定', exact: true }).click();
    const settingsVisible = await page.locator('.settings-screen').isVisible().catch(() => false);
    console.log('マイグレーション後に設定画面が開けるか:', settingsVisible);
    await page.screenshot({ path: `${SHOT_DIR}/q1-settings-screen-after-migration.png`, fullPage: true });

    // Dexieは内部的にversion番号を×10で管理する（version(1)→raw IndexedDB version 10、
    // version(4)→40）ため、rawバージョンは40になるのが正しい（4ではない）。
    // v4 で syncFolder を削除した（ローカルフォルダ編集機能の廃止に伴い未使用になったため）。
    expect(after.version).toBe(40);
    expect(after.storeNames).toEqual(
      ['asks', 'chatMessages', 'chatSessions', 'keyStore', 'notes', 'settings', 'terms'].sort(),
    );
  });

  test('Q2: settings.get()の同時呼び出し（StrictMode二重effect相当）', async ({ page }) => {
    // このテストのみdevサーバー(4178)を使う。production build(preview)ではStrictModeの
    // 意図的な二重effect実行が発生しないため、バグ1の再現条件を満たせない。
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await resetIndexedDb(page);
    await mockAiProviders(page);
    await page.goto('http://localhost:4178/');
    await waitForSeedSettled(page);
    await dismissOnboardingIfPresent(page);
    await page.waitForTimeout(1000); // StrictModeの二重effectは起動直後に発生する

    const statusText = await page.locator('.search-status').first().innerText();
    console.log('起動後のsearch-status文言:', statusText);

    // バグ1の症状=「3510語取り込み成功と表示されるのに検索が常に0件」を再現できるか確認
    await page.locator('.search-input').fill('API');
    await page.waitForTimeout(300);
    const resultCount = await page.locator('.search-result').count();
    console.log('StrictMode下での"API"検索結果件数:', resultCount);
    await page.screenshot({ path: `${SHOT_DIR}/q2-strictmode-after-boot.png`, fullPage: true });

    // settingsテーブルにsingletonレコードが1件だけ存在する（重複add衝突が起きていない）ことを直接確認
    const settingsCount = await page.evaluate(() => {
      return new Promise<number>((resolve, reject) => {
        const req = indexedDB.open('it-index');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('settings', 'readonly');
          const countReq = tx.objectStore('settings').count();
          countReq.onsuccess = () => resolve(countReq.result);
          countReq.onerror = () => reject(countReq.error);
        };
        req.onerror = () => reject(req.error);
      });
    });
    console.log('settingsストアのレコード件数（1件が正常、2件なら衝突していた可能性）:', settingsCount);
    console.log('起動中に捕捉されたconsole.error / pageerror:', JSON.stringify(errors));

    expect(settingsCount).toBe(1);
    expect(resultCount).toBeGreaterThan(0);
  });

  test('Q3: 複数タブ同時操作でのデータ整合性', async ({ browser }) => {
    const context: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pageA = await context.newPage();
    const pageB = await context.newPage();

    await resetIndexedDb(pageA); // 同一contextなのでDB削除は片方で十分
    await mockAiProviders(pageA);
    await mockAiProviders(pageB);

    await pageA.goto('/');
    await waitForSeedSettled(pageA);
    await dismissOnboardingIfPresent(pageA);

    // pageBは同じDBを開く2つ目のタブ（シード取り込み自体はpageAで完了済みのはず）
    await pageB.goto('/');
    await waitForSeedSettled(pageB);
    await dismissOnboardingIfPresent(pageB);

    // タブA: 検索を行う
    await pageA.locator('.search-input').fill('サーバ');
    await pageA.waitForTimeout(300);
    const countA = await pageA.locator('.search-result').count();
    console.log('タブA検索結果件数:', countA);

    // タブB: 用語詳細→チャット開始→送信→確定、という一連の書き込み操作を行う
    await pageB.locator('.search-input').fill('API');
    await pageB.waitForTimeout(300);
    await pageB.locator('.search-result').first().click();
    await expect(pageB.locator('.term-detail')).toBeVisible();
    await pageB.getByRole('button', { name: 'この語についてAIに聞く' }).click();
    await pageB.locator('.chat-screen, .api-key-prompt').first().waitFor({ state: 'visible', timeout: 10_000 });
    await connectApiKey(pageB);
    await pageB.locator('.chat-screen').waitFor({ state: 'visible', timeout: 10_000 });
    await pageB.locator('.chat-input-row textarea').fill('タブBからの質問です');
    await pageB.getByRole('button', { name: '送信', exact: true }).click();
    await expect(pageB.locator('.chat-message-assistant')).toContainText('モック応答です', { timeout: 10_000 });
    await pageB.getByRole('button', { name: 'この会話を確定する' }).click();
    await expect(pageB.locator('.search-screen')).toBeVisible({ timeout: 5_000 });
    await pageB.waitForTimeout(1500);

    // タブA側で並行して検索を継続（タブBの書き込み中も操作できるか）
    await pageA.locator('.search-input').fill('');
    await pageA.locator('.search-input').fill('データベース');
    await pageA.waitForTimeout(300);
    const countA2 = await pageA.locator('.search-result').count();
    console.log('タブB書き込み中/後のタブA検索結果件数:', countA2);
    await pageA.screenshot({ path: `${SHOT_DIR}/q3-tabA-after-tabB-write.png` });
    await pageB.screenshot({ path: `${SHOT_DIR}/q3-tabB-after-commit.png` });

    // DBの整合性を直接確認：settingsは1件のまま、chatSessionsはcommitted、例外が出ていないか
    const dbState = await pageA.evaluate(() => {
      return new Promise<{ settingsCount: number; sessions: { status: string }[] }>((resolve, reject) => {
        const req = indexedDB.open('it-index');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['settings', 'chatSessions'], 'readonly');
          const settingsCountReq = tx.objectStore('settings').count();
          const sessionsReq = tx.objectStore('chatSessions').getAll();
          let settingsCount = -1;
          tx.oncomplete = () => {
            resolve({ settingsCount, sessions: sessionsReq.result.map((s: { status: string }) => ({ status: s.status })) });
          };
          settingsCountReq.onsuccess = () => {
            settingsCount = settingsCountReq.result;
          };
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      });
    });
    console.log('2タブ操作後のDB状態:', JSON.stringify(dbState));

    // タブAをリロードして最新状態を読めるか（クロスタブ反映は自動ではない設計を確認する目的）
    await pageA.reload();
    await waitForSeedSettled(pageA);
    await dismissOnboardingIfPresent(pageA);
    const reloadedCount = await pageA.evaluate(() => 1); // noop placeholder for readability
    void reloadedCount;
    await pageA.screenshot({ path: `${SHOT_DIR}/q3-tabA-after-reload.png` });

    await context.close();
  });

  test('Q4: 空セッション（メッセージ0件）でのAI呼び出しスキップ回帰確認', async ({ page }) => {
    let aiCalled = false;
    await page.route('https://api.anthropic.com/v1/messages', async (route) => {
      aiCalled = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ content: [{ type: 'text', text: 'モック応答です。' }] }),
      });
    });
    await page.route('https://api.anthropic.com/v1/models', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ id: 'mock' }] }) }),
    );

    await resetIndexedDb(page);
    await page.goto('/');
    await waitForSeedSettled(page);
    await dismissOnboardingIfPresent(page);

    // 「AIに聞く」ボタンを押した直後（メッセージ0件）に離脱する
    await page.locator('.search-input').fill('API');
    await page.waitForTimeout(300);
    await page.locator('.search-result').first().click();
    await expect(page.locator('.term-detail')).toBeVisible();
    await page.getByRole('button', { name: 'この語についてAIに聞く' }).click();
    await page.locator('.chat-screen, .api-key-prompt').first().waitFor({ state: 'visible', timeout: 10_000 });
    await connectApiKey(page);
    await page.locator('.chat-screen').waitFor({ state: 'visible', timeout: 10_000 });

    // 一言も送らずに検索画面へ戻る（離脱）
    await page.getByRole('button', { name: '検索', exact: true }).click();
    await expect(page.locator('.search-screen')).toBeVisible();
    await page.waitForTimeout(500);
    console.log('離脱時点でAI呼び出しが発生したか:', aiCalled);

    // ホームの「AIによる単語更新待ち」一覧に空セッションが残っているか確認
    const pendingText = await page.locator('body').innerText();
    console.log('離脱後、画面内に「更新待ち」関連の文言があるか:', /更新待ち/.test(pendingText));
    await page.screenshot({ path: `${SHOT_DIR}/q4-after-leaving-empty-session.png`, fullPage: true });

    // 同じ用語のチャットを再度開く（findOpenSessionByTermIdにより同一の空セッションが再利用されるはず）。
    // UI自体がメッセージ0件の間は確定ボタンをdisabledにしている（src/ui/pc/ChatScreen.tsx:231
    // `disabled={messages.length === 0}`）ため、ここでは「押せない」ことを確認する
    // （commitOrchestrator側のガードとは別の、UI側の二重の安全策）。
    await page.locator('.search-input').fill('API');
    await page.waitForTimeout(300);
    await page.locator('.search-result').first().click();
    await page.getByRole('button', { name: 'この語についてAIに聞く' }).click();
    await page.locator('.chat-screen, .api-key-prompt').first().waitFor({ state: 'visible', timeout: 10_000 });
    await connectApiKey(page);
    await page.locator('.chat-screen').waitFor({ state: 'visible', timeout: 10_000 });
    const commitBtn = page.getByRole('button', { name: 'この会話を確定する' });
    const commitBtnDisabled = await commitBtn.isDisabled().catch(() => null);
    console.log('空セッション再訪時、確定ボタンがdisabledか:', commitBtnDisabled);
    await page.screenshot({ path: `${SHOT_DIR}/q4-after-commit-empty-session.png`, fullPage: true });

    console.log('一連の操作を通じてAI呼び出しが一度も発生しなかったか:', !aiCalled);
    expect(aiCalled).toBe(false);
    expect(commitBtnDisabled).toBe(true);
  });

  test('Q5: fetch自体がreject（オフライン/CORS模擬）した場合のエラー日本語化', async ({ page }) => {
    await page.route('https://api.anthropic.com/v1/messages', (route) => route.abort('failed'));
    await page.route('https://api.anthropic.com/v1/models', (route) => route.abort('failed'));

    await resetIndexedDb(page);
    await page.goto('/');
    await waitForSeedSettled(page);
    await dismissOnboardingIfPresent(page);

    await page.locator('.search-input').fill('API');
    await page.waitForTimeout(300);
    await page.locator('.search-result').first().click();
    await expect(page.locator('.term-detail')).toBeVisible();
    await page.getByRole('button', { name: 'この語についてAIに聞く' }).click();
    await page.locator('.chat-screen, .api-key-prompt').first().waitFor({ state: 'visible', timeout: 10_000 });

    // api-key-prompt側の「接続を確認」でもfetchがrejectする経路を通る
    if (await page.locator('.api-key-prompt').isVisible().catch(() => false)) {
      const scope = page.locator('.api-key-prompt');
      await scope.locator('input[type="password"]').fill('sk-ant-test-key-0000');
      await scope.getByRole('button', { name: '接続を確認' }).click();
      await page.waitForTimeout(1500);
      const promptText = await scope.innerText();
      console.log('api-key-prompt: 接続確認reject時の表示文言:', promptText);
      await page.screenshot({ path: `${SHOT_DIR}/q5-apikeyprompt-fetch-reject.png`, fullPage: true });
      const mentionsRawEnglishError = /Failed to fetch|TypeError|NetworkError/i.test(promptText);
      console.log('未翻訳の生英語エラーが含まれるか（api-key-prompt）:', mentionsRawEnglishError);
    } else {
      await page.locator('.chat-screen').waitFor({ state: 'visible', timeout: 10_000 });
      await page.locator('.chat-input-row textarea').fill('オフライン模擬テスト');
      await page.getByRole('button', { name: '送信', exact: true }).click();
      await page.waitForTimeout(1500);
      const chatText = await page.locator('.chat-screen').innerText();
      console.log('チャット画面: fetch reject時の表示文言:', chatText);
      await page.screenshot({ path: `${SHOT_DIR}/q5-chatscreen-fetch-reject.png`, fullPage: true });
      const mentionsRawEnglishError = /Failed to fetch|TypeError|NetworkError/i.test(chatText);
      console.log('未翻訳の生英語エラーが含まれるか（chat screen）:', mentionsRawEnglishError);
      const mentionsJapaneseGuidance = /接続できませんでした|ネットワーク/.test(chatText);
      console.log('日本語の案内文言が含まれるか:', mentionsJapaneseGuidance);
    }
  });

  test('Q6: globalErrorのXボタンでの消去確認', async ({ page }) => {
    // globalErrorは主にcommitOrchestrator.onError→App.tsxのsetGlobalErrorで発生する
    // （src/App.tsx:133-136）。これを実際に踏むには「メッセージ送信済みのセッションを、
    // 確定処理（AI呼び出し）だけ失敗させる」必要がある。手順:
    //   1. 通常どおり接続・送信を成功させる（メッセージを1件以上作る）
    //   2. 確定ボタンを押す直前にAPIルートをabortに切り替え、proposeDistribution内のsend()を失敗させる
    //   3. commitOrchestrator.onErrorが呼ばれ、App.tsxのglobalErrorにセットされ、Toastが表示される
    let shouldAbort = false;
    await page.route('https://api.anthropic.com/v1/messages', async (route) => {
      if (shouldAbort) {
        await route.abort('failed');
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ content: [{ type: 'text', text: 'モック応答です。' }] }),
      });
    });
    await page.route('https://api.anthropic.com/v1/models', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ id: 'mock' }] }) }),
    );

    await resetIndexedDb(page);
    await page.goto('/');
    await waitForSeedSettled(page);
    await dismissOnboardingIfPresent(page);

    await page.locator('.search-input').fill('API');
    await page.waitForTimeout(300);
    await page.locator('.search-result').first().click();
    await expect(page.locator('.term-detail')).toBeVisible();
    await page.getByRole('button', { name: 'この語についてAIに聞く' }).click();
    await page.locator('.chat-screen, .api-key-prompt').first().waitFor({ state: 'visible', timeout: 10_000 });
    await connectApiKey(page);
    await page.locator('.chat-screen').waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator('.chat-input-row textarea').fill('確定処理失敗を再現するための質問');
    await page.getByRole('button', { name: '送信', exact: true }).click();
    await expect(page.locator('.chat-message-assistant')).toContainText('モック応答です', { timeout: 10_000 });

    // ここから確定処理だけを失敗させる
    shouldAbort = true;
    await page.getByRole('button', { name: 'この会話を確定する' }).click();
    // commitOrchestratorはバックグラウンドで進む（他spec同様、DB反映待ちに1.5秒待つ慣例に倣う）
    await expect(page.locator('.search-screen')).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(1500);

    const toastLocator = page.locator('.toast-error');
    const toastVisible = await toastLocator.isVisible({ timeout: 5_000 }).catch(() => false);
    console.log('Q6: 確定処理失敗後にtoast-error（globalError）が表示されたか:', toastVisible);
    expect(toastVisible).toBe(true);

    const toastText = await toastLocator.innerText();
    console.log('Q6: toast-errorの文言:', toastText);
    await page.screenshot({ path: `${SHOT_DIR}/q6-toast-before-dismiss.png`, fullPage: true });

    await toastLocator.getByRole('button', { name: '閉じる' }).click();
    await page.waitForTimeout(200);
    const stillVisible = await toastLocator.isVisible().catch(() => false);
    console.log('Q6: Xボタン押下後もtoast-errorが残っているか:', stillVisible);
    await page.screenshot({ path: `${SHOT_DIR}/q6-toast-after-dismiss.png`, fullPage: true });
    expect(stillVisible).toBe(false);
  });
});
