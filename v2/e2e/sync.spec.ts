import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * 画面を通した同期のE2E(#231)。
 *
 * **これまでE2Eにはバックエンドが無かった。** `vite preview` で静的配信していただけで
 * `/api` が存在せず、ログイン・同期・鍵の受け渡し・競合表示は**画面越しに一度も
 * 動かされていなかった**。単体テスト(jsdom)が緑であることは「画面から使える」ことを
 * 何も保証しない——jsdomはヒットテストもレイアウトもしないため、押せるか・重なっていないかは別問題。
 *
 * ここでは `wrangler dev`(本番と同じく同一Workerで /api と静的配信)を相手に、
 * **ブラウザコンテキスト＝端末**として複数台を再現する。localStorage と IndexedDB が
 * コンテキストごとに分かれるため、1台のマシンで2台以上の端末になる。
 *
 * 落ちた時に切り分けられるよう、**通る順に1本ずつ**積んである。
 */

/** 初回起動のオンボーディングは画面全体のクリックを奪う(smoke.spec.tsと同じ理由) */
async function dismissOnboarding(page: Page) {
  const skip = page.getByText('スキップ');
  if (await skip.isVisible().catch(() => false)) {
    await skip.click();
  }
}

/** シード取り込みが終わるまで待つ。ここを待たないと以降の操作が空振りする */
async function openApp(page: Page) {
  await page.goto('/');
  await dismissOnboarding(page);
  await expect(page.getByText(/登録単語数\(\d+語\)/)).toBeVisible({ timeout: 30_000 });
}

async function gotoSyncTab(page: Page) {
  await page.getByRole('button', { name: '同期', exact: true }).click();
}

/** 端末を1つ用意する(コンテキスト=端末)。同じアカウントに複数台がぶら下がる形を作る */
async function openDevice(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await openApp(page);
  return page;
}

function uniqueEmail(): string {
  return `e2e-${Date.now()}-${Math.floor(Math.random() * 100000)}@example.com`;
}

const PASSWORD = 'TestPass2026';

/**
 * 検索結果から開く語。**完全一致で指す**——「TCP/IP」で前方一致にすると
 * 「TCP/IPプロトコル体系」にも当たり、Playwrightのstrictモードで落ちる(実際に踏んだ)。
 * smoke.spec.ts と同じ指し方にそろえてある。
 */
const TERM_OPTION = 'TCP/IP ティーシーピーアイピー ネットワーク';

async function signup(page: Page, email: string) {
  await gotoSyncTab(page);
  await page.getByRole('button', { name: '新規登録' }).click();
  await page.getByLabel('メールアドレス').fill(email);
  await page.getByLabel('パスワード', { exact: true }).fill(PASSWORD);
  await page.getByLabel('パスワード(確認)').fill(PASSWORD);
  await page.getByRole('button', { name: '登録する' }).click();
  await expect(page.getByText(new RegExp(`ログイン中: ${email}`))).toBeVisible({ timeout: 20_000 });
}

async function login(page: Page, email: string) {
  await gotoSyncTab(page);
  // 完全一致で指す: 既定の部分一致だと送信ボタンの「ログインする」にも当たる(実際に踏んだ)
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  await page.getByLabel('メールアドレス').fill(email);
  await page.getByLabel('パスワード', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'ログインする' }).click();
  await expect(page.getByText(new RegExp(`ログイン中: ${email}`))).toBeVisible({ timeout: 20_000 });
}

test.describe('画面を通した同期(実バックエンド)', () => {
  test('1: 新規登録すると画面がログイン済みに変わる', async ({ page }) => {
    await openApp(page);
    await signup(page, uniqueEmail());

    // ログアウトできる=セッションが画面の状態として成立している
    await expect(page.getByRole('button', { name: 'ログアウト' })).toBeVisible();
  });

  /**
   * #226 の鍵ゲートを**実ブラウザで**確かめる。
   * jsdomでは「disabled属性が付いているか」しか見ていないが、ここでは実際に押せないことを見る。
   */
  test('2: 鍵が無い間は「今すぐ同期」を押せず、作ると押せるようになる(#226)', async ({ page }) => {
    await openApp(page);
    await signup(page, uniqueEmail());

    const syncNow = page.getByRole('button', { name: '今すぐ同期' });
    await expect(page.getByTestId('sync-key-required')).toBeVisible();
    await expect(syncNow).toBeDisabled();

    await page.getByRole('button', { name: 'この端末で新しく鍵を作る' }).click();

    await expect(page.getByTestId('sync-key-required')).toBeHidden();
    await expect(syncNow).toBeEnabled();
  });

  /**
   * 同期が画面から実際に成立することを見る。**ここが今まで一度も通っていなかった。**
   * 2台目は数字コードで鍵を受け取る(コードは画面に出るのでコンテキスト間で渡せる)。
   */
  test('3: 2端末で鍵を受け渡し、片方のノートがもう片方へ届く', async ({ browser }) => {
    const email = uniqueEmail();
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();

    try {
      const deviceA = await openDevice(contextA);
      await signup(deviceA, email);
      await deviceA.getByRole('button', { name: 'この端末で新しく鍵を作る' }).click();

      // 端末Aで語を開き、ノートを書く
      await deviceA.getByRole('button', { name: '検索', exact: true }).click();
      await deviceA.getByRole('combobox', { name: '用語を検索' }).fill('TCP/IP');
      await deviceA.getByRole('option', { name: TERM_OPTION }).click();
      const noteBody = `E2Eで書いた本文 ${Date.now()}`;
      await deviceA.getByRole('textbox', { name: 'ノート本文' }).fill(noteBody);
      await deviceA.getByRole('button', { name: '保存する' }).click();
      await expect(deviceA.getByText('保存しました')).toBeVisible({ timeout: 10_000 });

      // 端末Aが同期(push)
      await gotoSyncTab(deviceA);
      await deviceA.getByRole('button', { name: '今すぐ同期' }).click();
      await expect(deviceA.getByTestId('sync-result')).toBeVisible({ timeout: 30_000 });

      // 端末Bでログイン → 数字コードで鍵を受け取る
      const deviceB = await openDevice(contextB);
      await login(deviceB, email);

      // 数字コードは「QRが使えない場合」の中にしまわれている(2段階。弱い方を素で選ばせない設計)
      await deviceA.getByRole('button', { name: 'QRが使えない場合' }).click();
      await deviceA.getByRole('button', { name: '数字コードを表示する(渡す側)' }).click();
      const code = await deviceA.getByTestId('issued-code').innerText();
      const digits = code.replace(/\D/g, '');
      expect(digits).toHaveLength(8);

      await deviceB.getByRole('button', { name: 'QRが使えない場合' }).click();
      await deviceB.getByRole('button', { name: '数字コードを入力する(受け取る側)' }).click();
      await deviceB.getByLabel(/相手の画面に出ている8桁/).fill(digits);
      await deviceB.getByRole('button', { name: '鍵を受け取る' }).click();
      await expect(deviceB.getByTestId('key-transfer-done')).toBeVisible({ timeout: 30_000 });

      /*
       * **鍵を受け取ると、サーバー上の差分は全部消える**(KeyTransferSection.adoptKey)。
       * 受け取り側が鍵を受け取る前に自分の鍵でpushしていた場合、その差分が誰にも復号できない
       * 孤児になり相手のカーソルを止めるため、まとめて消す設計になっている(#182)。
       *
       * つまり**受け取り側が同期しても、送信側が再pushするまでは何も届かない**。
       * ここでAが同期し直すのはその実態を写したもの(このE2Eで初めて分かった)。
       */
      await gotoSyncTab(deviceA);
      await deviceA.getByRole('button', { name: '今すぐ同期' }).click();
      await expect(deviceA.getByTestId('sync-result')).toBeVisible({ timeout: 30_000 });

      // 端末Bが同期(pull) → 端末Aのノートが届く
      await deviceB.getByRole('button', { name: '今すぐ同期' }).click();
      await expect(deviceB.getByTestId('sync-result')).toBeVisible({ timeout: 30_000 });

      await deviceB.getByRole('button', { name: '検索', exact: true }).click();
      await deviceB.getByRole('combobox', { name: '用語を検索' }).fill('TCP/IP');
      await deviceB.getByRole('option', { name: TERM_OPTION }).click();
      await expect(deviceB.getByRole('textbox', { name: 'ノート本文' })).toHaveValue(noteBody);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});
