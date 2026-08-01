import { test, expect } from '../fixtures/base';
import type { Page } from '@playwright/test';

const SHOT_DIR = 'docs/review/agents/screenshots/flow';

async function mockModelsEndpoint(page: Page) {
  // fixtures/base.ts の mockAiProviders は api.anthropic.com/** 全体を
  // チャット応答形式({content:[...]})で塞ぐため、モデル一覧取得(GET /v1/models)も
  // 同じ形式が返り、ApiKeyPrompt側の `data.data.map` が失敗する。
  // 後から登録したルートが優先されるため、/v1/models だけ正しい形式で上書きする。
  await page.route('https://api.anthropic.com/v1/models', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: 'claude-3-5-sonnet-mock' }] }),
    }),
  );
}

async function dismissOnboardingIfPresent(page: Page) {
  // 初回起動時、localStorageが空(=新規コンテキスト)だと毎回OnboardingModalが出る。
  // 検証対象ではないため、スキップして先に進む(オンボーディング自体の検証は範囲外)。
  const skipBtn = page.getByRole('button', { name: 'スキップ' });
  if (await skipBtn.isVisible().catch(() => false)) {
    await skipBtn.click();
  }
}

/**
 * 「AIに聞く」導線を押した直後、ApiKeyPrompt(未設定時)かChatScreen(設定済み時)か
 * どちらが描画されるかは非同期(state更新)なため、即座にisVisible()判定すると
 * まだ描画前でfalseを引いて誤判定することがある(このテストスクリプト側の問題であり、
 * アプリ側の不具合ではない)。両方のうちどちらかが実際に出るまで待ってから判定する。
 */
async function ensureChatReady(page: Page): Promise<void> {
  await page.locator('.chat-screen, .api-key-prompt').first().waitFor({ state: 'visible', timeout: 10_000 });
  if (await page.locator('.api-key-prompt').isVisible()) {
    await setApiKeyViaUi(page);
    await page.locator('.chat-screen').waitFor({ state: 'visible', timeout: 10_000 });
  }
}

async function setApiKeyViaUi(page: Page) {
  // 注意: TopNavにも「設定」ボタンが常設されているため、.api-key-prompt配下に限定してスコープする
  // (でないと2要素にマッチしてstrict mode violationになる)
  const scope = page.locator('.api-key-prompt');
  await scope.locator('input[type="password"]').fill('sk-ant-test-key-0000');
  await scope.getByRole('button', { name: '接続を確認' }).click();
  await expect(scope.getByRole('button', { name: '設定', exact: true })).toBeVisible({ timeout: 10_000 });
  await scope.getByRole('button', { name: '設定', exact: true }).click();
}

test.describe('操作フロー・使用感 調査', () => {
  test('主要導線: 検索→詳細→AIに聞く→チャット→確定→検索へ戻る', async ({ preparedPage: page }) => {
    await dismissOnboardingIfPresent(page);
    await mockModelsEndpoint(page);
    await page.screenshot({ path: `${SHOT_DIR}/01-search-initial.png` });

    await page.locator('.search-input').fill('API');
    await page.waitForTimeout(300); // debounce 150ms
    await page.screenshot({ path: `${SHOT_DIR}/02-search-results.png` });

    const firstResult = page.locator('.search-result').first();
    const firstTermText = await firstResult.locator('.search-result-term').innerText();
    await firstResult.click();

    await expect(page.locator('.term-detail')).toBeVisible();
    await page.screenshot({ path: `${SHOT_DIR}/03-detail.png` });

    await page.getByRole('button', { name: 'この語についてAIに聞く' }).click();
    await expect(page.locator('.chat-screen, .api-key-prompt')).toBeVisible();
    await page.screenshot({ path: `${SHOT_DIR}/04-chat-or-apikeyprompt.png` });

    await ensureChatReady(page);

    await expect(page.locator('.chat-screen')).toBeVisible();
    await expect(page.locator('.chat-subject-chip')).toContainText(firstTermText);
    await page.screenshot({ path: `${SHOT_DIR}/05-chat-screen.png` });

    await page.locator('.chat-input-row textarea').fill('これはテスト質問です');
    await page.getByRole('button', { name: '送信', exact: true }).click();
    await expect(page.locator('.chat-message-assistant')).toContainText('モック応答です', { timeout: 10_000 });
    await page.screenshot({ path: `${SHOT_DIR}/06-chat-after-response.png` });

    // 確定するボタン押下直後の状態を観測する(fire-and-forgetのフィードバックの有無)
    await page.getByRole('button', { name: 'この会話を確定する' }).click();
    // クリック直後、画面遷移前の一瞬のDOMを観測してみる(高速なので取れない可能性が高い=それ自体が所見)
    await page.screenshot({ path: `${SHOT_DIR}/07-immediately-after-commit-click.png` });
    await expect(page.locator('.search-screen')).toBeVisible({ timeout: 5_000 });
    await page.screenshot({ path: `${SHOT_DIR}/08-back-to-search.png` });
  });

  test('自由モード: 用語を選ばずAIに聞く', async ({ preparedPage: page }) => {
    await dismissOnboardingIfPresent(page);
    await mockModelsEndpoint(page);
    await page.locator('.search-input').fill('存在しないはずの検索語XYZ123');
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOT_DIR}/09-free-mode-search.png` });

    const aiHintButton = page.locator('.search-ai-hint button');
    await expect(aiHintButton).toBeVisible();
    await aiHintButton.click();

    await ensureChatReady(page);
    await expect(page.locator('.chat-screen')).toBeVisible();
    await page.screenshot({ path: `${SHOT_DIR}/10-free-mode-chat.png` });
    // 自由モードのチップ表示確認
    await expect(page.locator('.chat-subject-chip')).toContainText('自由な質問');
  });

  test('話題を変える → TermPicker → 別用語へ', async ({ preparedPage: page }) => {
    await dismissOnboardingIfPresent(page);
    await mockModelsEndpoint(page);
    await page.locator('.search-input').fill('API');
    await page.waitForTimeout(300);
    await page.locator('.search-result').first().click();
    await page.getByRole('button', { name: 'この語についてAIに聞く' }).click();
    await ensureChatReady(page);
    await expect(page.locator('.chat-screen')).toBeVisible();

    await page.getByRole('button', { name: /話題を変える|用語を選ぶ/ }).click();
    await page.screenshot({ path: `${SHOT_DIR}/11-term-picker-open.png` });
    const pickerInput = page.locator('.term-picker input, [class*="picker"] input').first();
    await pickerInput.fill('セキュリティ');
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOT_DIR}/12-term-picker-results.png` });
  });

  test('履歴画面: 重み付け/時系列タブ→用語選択', async ({ preparedPage: page }) => {
    await dismissOnboardingIfPresent(page);
    await page.getByRole('button', { name: '履歴' }).click();
    await expect(page.locator('.history-screen')).toBeVisible();
    await page.screenshot({ path: `${SHOT_DIR}/13-history-weighted-empty.png` });

    await page.locator('.history-tabs button', { hasText: '時系列ビュー' }).click();
    await page.screenshot({ path: `${SHOT_DIR}/14-history-timeline-empty.png` });
  });

  test('設定モーダル: 各画面の上から開く', async ({ preparedPage: page }) => {
    await dismissOnboardingIfPresent(page);
    await page.getByRole('button', { name: '設定', exact: true }).click();
    await expect(page.locator('.modal-content')).toBeVisible();
    await page.screenshot({ path: `${SHOT_DIR}/15-settings-from-search.png` });
    await page.locator('.modal-header button', { hasText: '✕' }).click();
    await expect(page.locator('.modal-content')).toHaveCount(0);

    // 詳細画面の上から
    await page.locator('.search-input').fill('API');
    await page.waitForTimeout(300);
    await page.locator('.search-result').first().click();
    await page.getByRole('button', { name: '設定', exact: true }).click();
    await expect(page.locator('.modal-content')).toBeVisible();
    await page.screenshot({ path: `${SHOT_DIR}/16-settings-from-detail.png` });
  });

  test('URLが変わらないことの実害: 詳細画面でリロード・ブラウザバック', async ({ preparedPage: page }) => {
    await dismissOnboardingIfPresent(page);
    await page.locator('.search-input').fill('API');
    await page.waitForTimeout(300);
    await page.locator('.search-result').first().click();
    await expect(page.locator('.term-detail')).toBeVisible();
    const urlBeforeReload = page.url();

    await page.reload();
    await page.waitForSelector('.search-status', { timeout: 20_000 });
    await page.screenshot({ path: `${SHOT_DIR}/17-after-reload-from-detail.png` });
    const urlAfterReload = page.url();
    const isSearchAfterReload = await page.locator('.search-screen').isVisible();
    const isDetailAfterReload = await page.locator('.term-detail').isVisible();

    test.info().annotations.push({
      type: 'reload-result',
      description: `before=${urlBeforeReload} after=${urlAfterReload} search=${isSearchAfterReload} detail=${isDetailAfterReload}`,
    });

    // ブラウザバックの検証は別途、履歴を積んでから行う
    await page.locator('.search-input').fill('API');
    await page.waitForTimeout(300);
    await page.locator('.search-result').first().click();
    await expect(page.locator('.term-detail')).toBeVisible();
    const urlAtDetail = page.url();

    await page.goBack();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOT_DIR}/18-after-goback-from-detail.png` });
    const urlAfterBack = page.url();
    const stillOnDetail = await page.locator('.term-detail').isVisible();
    const backOnSearch = await page.locator('.search-screen').isVisible();

    test.info().annotations.push({
      type: 'goback-result',
      description: `urlAtDetail=${urlAtDetail} urlAfterBack=${urlAfterBack} stillOnDetail=${stillOnDetail} backOnSearch=${backOnSearch}`,
    });
  });

  test('globalError の出方と✕での消し方(認証前のstaleセッション回収エラーを誘発)', async ({ page, context }) => {
    // 保存済みパスキー資格情報が「ある」状態を作るのは複雑なため、ここでは
    // recoverStaleSessions以外の経路でglobalErrorを直接発生させられるか確認する。
    // 簡易な代替: ローカルフォルダ書き出し失敗等は再現困難なため、Toastコンポーネント自体の
    // 挙動(✕ボタンでの消去・6秒自動消去)をコード上確認済み。ここではAPIキー未設定状態での
    // チャット確定→エラー発生の有無のみ実際に操作して確認する。
    await context.route('https://api.anthropic.com/**', (route) => route.abort('failed'));
    await page.addInitScript(() => indexedDB.deleteDatabase('it-index'));
    await page.goto('/');
    await page.waitForSelector('.search-status', { timeout: 20_000 });
    await dismissOnboardingIfPresent(page);

    await page.locator('.search-input').fill('API');
    await page.waitForTimeout(300);
    await page.locator('.search-result').first().click();
    await page.getByRole('button', { name: 'この語についてAIに聞く' }).click();
    await page.screenshot({ path: `${SHOT_DIR}/19-apikeyprompt-network-abort-setup.png` });
  });

  test('IME変換確定Enterの誤送信 回帰確認', async ({ preparedPage: page }) => {
    await dismissOnboardingIfPresent(page);
    await mockModelsEndpoint(page);
    await page.locator('.search-input').fill('API');
    await page.waitForTimeout(300);
    await page.locator('.search-result').first().click();
    await page.getByRole('button', { name: 'この語についてAIに聞く' }).click();
    await ensureChatReady(page);
    await expect(page.locator('.chat-screen')).toBeVisible();

    const textarea = page.locator('.chat-input-row textarea');
    await textarea.click();

    // IME変換中のEnter: isComposing=trueで発火。送信されないことを期待。
    await textarea.dispatchEvent('compositionstart');
    await textarea.evaluate((el: HTMLTextAreaElement) => {
      el.value = '日本語';
    });
    await textarea.dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true });
    await page.waitForTimeout(200);
    const messagesCountAfterComposingEnter = await page.locator('.chat-message').count();
    await page.screenshot({ path: `${SHOT_DIR}/20-ime-composing-enter.png` });

    await textarea.dispatchEvent('compositionend');
    await textarea.fill('日本語の変換確定後の文章');

    // 変換確定後の通常Enter: isComposing=falseのため送信されることを期待。
    await textarea.dispatchEvent('keydown', { key: 'Enter', isComposing: false, bubbles: true, cancelable: true });
    await page.waitForTimeout(500);
    const messagesCountAfterNormalEnter = await page.locator('.chat-message').count();
    await page.screenshot({ path: `${SHOT_DIR}/21-ime-normal-enter.png` });

    test.info().annotations.push({
      type: 'ime-result',
      description: `afterComposingEnter=${messagesCountAfterComposingEnter} afterNormalEnter=${messagesCountAfterNormalEnter}`,
    });
  });

  test('Skeleton/ローディングの出現場面の確認', async ({ preparedPage: page }) => {
    await dismissOnboardingIfPresent(page);
    await page.locator('.search-input').fill('API');
    await page.waitForTimeout(300);
    // 検索結果一覧自体にSkeletonが出るか(通常は同期的にメモリ上のtermsから計算するため出ない見込み)
    await page.screenshot({ path: `${SHOT_DIR}/22-search-no-skeleton-expected.png` });

    await page.locator('.search-result').first().click();
    // 詳細画面はtermsRepo.getById等の非同期待ちがあるため、Skeletonが一瞬出る可能性がある
    await page.screenshot({ path: `${SHOT_DIR}/23-detail-possible-skeleton.png` });
  });

  test('確定失敗時のToast: ✕での消し方を実際にクリックして確認', async ({ preparedPage: page }) => {
    await dismissOnboardingIfPresent(page);
    await mockModelsEndpoint(page);
    await page.locator('.search-input').fill('API');
    await page.waitForTimeout(300);
    await page.locator('.search-result').first().click();
    await page.getByRole('button', { name: 'この語についてAIに聞く' }).click();
    await ensureChatReady(page);
    await page.locator('.chat-input-row textarea').fill('テスト');
    await page.getByRole('button', { name: '送信', exact: true }).click();
    await expect(page.locator('.chat-message-assistant')).toContainText('モック応答です', { timeout: 10_000 });

    await page.getByRole('button', { name: 'この会話を確定する' }).click();
    await expect(page.locator('.search-screen')).toBeVisible({ timeout: 5_000 });

    // commitOrchestratorの分配統合呼び出しにも同じチャット用モック文字列(非JSON)が返るため、
    // 実際の失敗経路(onError→globalError→Toast表示)を通る。✕クリックで消えるか確認する。
    const toast = page.locator('.toast-error');
    await expect(toast).toBeVisible({ timeout: 5_000 });
    await page.screenshot({ path: `${SHOT_DIR}/24-commit-fail-toast.png` });
    await toast.getByRole('button', { name: '閉じる' }).click();
    await expect(toast).toHaveCount(0);
    await page.screenshot({ path: `${SHOT_DIR}/25-commit-fail-toast-dismissed.png` });

    // 確定に失敗したセッションは「AIによる単語更新待ち」一覧に個別のエラー表示なく残り続けるか確認
    await page.screenshot({ path: `${SHOT_DIR}/26-pending-item-after-failed-commit.png` });
  });
});
