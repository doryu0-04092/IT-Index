import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * 5端末で競合を起こし、**画面にどう出るか**を確かめる(#231の続き。本人指定)。
 *
 * ロジック層は `integration/conflictRounds.integration.test.ts` が実サーバー相手に
 * 押さえている。ここで見たいのは**画面でしか確かめられないこと**:
 *
 * - 1枚のカードに「この端末＋相手4台」が縦一列で並ぶか(#203/#224)
 * - 競合履歴タブでも**同じ形**で出るか(#225)
 * - 同期画面から競合履歴へ行けるか(#225)
 * - 解消の操作が実ブラウザで押せて、記録が意図どおり動くか
 *
 * **鍵の受け渡しは事前状態として仕込む。** 受け渡しの導線そのものは sync.spec.ts が
 * 画面から通しているので、ここで4回繰り返す必要は無い(しかも受け渡しのたびに
 * サーバー上の差分が消えるため、5台ぶん繰り返すと本題に入る前に時間を使う)。
 */

const TERM_OPTION = 'TCP/IP ティーシーピーアイピー ネットワーク';
const PASSWORD = 'TestPass2026';
const DEVICE_NAMES = ['A', 'B', 'C', 'D', 'E'] as const;

/** base64url の32バイト。クライアントの generateDataKey と同じ形 */
function makeDataKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function uniqueEmail(): string {
  return `e2e-conflict-${Date.now()}-${Math.floor(Math.random() * 100000)}@example.com`;
}

/**
 * 端末を1つ用意する。ログイン済み・鍵あり・オンボーディング既読の状態を
 * localStorage に仕込んでから開く(実際の端末が受け渡しを終えた後と同じ状態)。
 */
async function openDevice(
  context: BrowserContext,
  state: { token: string; accountId: string; dataKey: string },
): Promise<Page> {
  await context.addInitScript((s) => {
    localStorage.setItem('it-index-v2:token', s.token);
    localStorage.setItem('it-index-v2:account-id', s.accountId);
    localStorage.setItem(`it-index-v2:sync-data-key:${s.accountId}`, s.dataKey);
    localStorage.setItem('it-index-v2-onboarding-seen', '1');
  }, state);

  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByText(/登録単語数\(\d+語\)/)).toBeVisible({ timeout: 30_000 });
  return page;
}

/** その端末で語のノートを書き換えて保存する */
async function writeNote(page: Page, body: string) {
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await page.getByRole('combobox', { name: '用語を検索' }).fill('TCP/IP');
  await page.getByRole('option', { name: TERM_OPTION }).click();
  await page.getByRole('textbox', { name: 'ノート本文' }).fill(body);
  await page.getByRole('button', { name: '保存する' }).click();
  await expect(page.getByText('保存しました')).toBeVisible({ timeout: 10_000 });
}

async function syncNow(page: Page) {
  await page.getByRole('button', { name: '同期', exact: true }).click();
  await page.getByRole('button', { name: '今すぐ同期' }).click();
  await expect(page.getByTestId('sync-result')).toBeVisible({ timeout: 30_000 });
}

test.describe('5端末の競合が画面にどう出るか', () => {
  test.setTimeout(180_000);

  test('1枚のカードに自分+4台が並び、履歴でも同じ形で出て、解消できる', async ({ browser, request }) => {
    const email = uniqueEmail();
    const signupRes = await request.post('/api/auth/signup', {
      data: { email, password: PASSWORD },
    });
    expect(signupRes.status()).toBe(201);
    const { token } = (await signupRes.json()) as { token: string };
    const meRes = await request.get('/api/auth/me', {
      headers: { authorization: `Bearer ${token}` },
    });
    const { accountId } = (await meRes.json()) as { accountId: string };
    const dataKey = makeDataKey();

    const contexts: BrowserContext[] = [];
    try {
      const pages: Page[] = [];
      for (const _name of DEVICE_NAMES) {
        const context = await browser.newContext();
        contexts.push(context);
        pages.push(await openDevice(context, { token, accountId, dataKey }));
      }
      const [deviceA, ...others] = pages;

      /* ── 5端末が同じ語を別内容にする ─────────────────────────────── */
      for (const [i, page] of pages.entries()) {
        await writeNote(page, `${DEVICE_NAMES[i]}が書いた内容`);
      }
      // A以外がpushしてから、Aが同期して競合を受け取る
      for (const page of others) await syncNow(page);
      await syncNow(deviceA);

      /* ── 1枚のカードに自分+4台が縦一列で並ぶ(#203/#224) ─────────────── */
      // termIdはシードから作られる実際の値なので、決め打ちせず接頭辞で指す(実際に踏んだ)
      const group = deviceA.getByTestId(/^conflict-group-/);
      await expect(group).toBeVisible();
      await expect(deviceA.getByText('4台の端末と内容が食い違っています')).toBeVisible();
      // 同じ語の競合は1枚にまとまる(端末ごとに別カードへ散らない)
      await expect(deviceA.getByTestId(/^conflict-group-/)).toHaveCount(1);
      // 相手4台ぶんの行がある
      await expect(group.getByTestId(/^conflict-device-/)).toHaveCount(4);
      // 「この端末の内容」が一番上に固定される(本人指定)
      await expect(group.getByText('この端末の内容', { exact: false }).first()).toBeVisible();

      /* ── 同期画面 → 競合履歴へ行ける(#225) ──────────────────────── */
      await deviceA.getByRole('button', { name: '競合履歴を見る' }).click();
      const historyGroup = deviceA.getByTestId(/^conflict-group-/);
      await expect(historyGroup).toBeVisible();
      // **同期画面と同じ形**で出る(同じコンポーネント。#225)
      await expect(historyGroup.getByTestId(/^conflict-device-/)).toHaveCount(4);

      /* ── 解消できる(実ブラウザで押せる) ─────────────────────────── */
      await deviceA.getByRole('button', { name: '同期', exact: true }).click();

      /*
       * **「この端末の内容」を1回押しても、解消されるのは競合1件だけ**(このE2Eで判明)。
       * 採用ボタンはグループの上部に1つしか無いのに、内部では競合レコード1件にしか
       * resolution が付かない(ConflictGroupItem → onChooseLocal(localTarget))。
       * 4台と食い違っていれば4回押すことになる。
       *
       * ここでは**現在の挙動をそのまま写している**。まとめて解消すべきかは設計判断なので、
       * 勝手に変えず、押すたびに1件ずつ減ることを固定して見える化しておく。
       */
      const adoptLocal = () =>
        deviceA.getByTestId(/^conflict-group-/).getByRole('button', { name: 'こちらを採用' }).first();
      for (const remaining of [3, 2, 1]) {
        await adoptLocal().click();
        await expect(
          deviceA.getByText(`${remaining}台の端末と内容が食い違っています`),
        ).toBeVisible({ timeout: 15_000 });
      }
      await adoptLocal().click();

      /*
       * 4件すべて解消すると「未解決の競合」の節が消える。
       * **カード自体は残る**——#225で表示を統一したため、「解決済みの競合」も
       * 同じ ConflictGroupItem で描かれる(testidも同じ)。未解決かどうかは節で見分ける。
       */
      await expect(deviceA.getByRole('heading', { name: /^未解決の競合/ })).toBeHidden({ timeout: 15_000 });
      await expect(deviceA.getByRole('heading', { name: /^解決済みの競合/ })).toBeVisible();

      /* ── 解消後にまた競合させる(複数端末) ───────────────────────── */
      await syncNow(deviceA); // 決定をpush
      const deviceB = others[0];
      const deviceD = others[2];
      await syncNow(deviceB);
      await syncNow(deviceD);
      await writeNote(deviceB, 'Bが解消後に書いた内容');
      await writeNote(deviceD, 'Dが解消後に書いた内容');
      await syncNow(deviceB);
      await syncNow(deviceD);
      await syncNow(deviceA);

      // 新しい競合として2台ぶんが立つ(決着済みの記録は残ったまま)
      await expect(deviceA.getByRole('heading', { name: /^未解決の競合/ })).toBeVisible({ timeout: 15_000 });
      const reConflict = deviceA
        .getByTestId(/^conflict-group-/)
        .filter({ hasText: '2台の端末と内容が食い違っています' });
      await expect(reConflict).toHaveCount(1);
      await expect(reConflict.getByTestId(/^conflict-device-/)).toHaveCount(2);
      /*
       * 決着済みの記録は**履歴タブ**で残る。
       * 同期画面の「解決済みの競合」は**直近の同期に紐づく分だけ**を出す設計(#157)なので、
       * 同期を重ねた後はここから消える——消えたのは記録ではなく表示範囲。
       */
      await deviceA.getByRole('button', { name: '競合履歴を見る' }).click();
      await expect(deviceA.getByText('この端末の内容にしました。').first()).toBeVisible({
        timeout: 15_000,
      });
    } finally {
      for (const context of contexts) await context.close();
    }
  });
  /**
   * **競合の解消をして初めて、その内容が他の端末でも共有される(#234)。**
   *
   * 以前は競合していても newest-wins で内容を確定していたため、利用者が何もしていないのに
   * 自分の書いた本文が相手の版へ置き換わっていた。画面から見えるのはここなので、
   * 実ブラウザでも固定しておく。
   */
  test('解消するまで自分の内容のまま。解消して初めて相手へ届く(#234)', async ({ browser, request }) => {
    const email = uniqueEmail();
    const signupRes = await request.post('/api/auth/signup', { data: { email, password: PASSWORD } });
    expect(signupRes.status()).toBe(201);
    const { token } = (await signupRes.json()) as { token: string };
    const meRes = await request.get('/api/auth/me', { headers: { authorization: `Bearer ${token}` } });
    const { accountId } = (await meRes.json()) as { accountId: string };
    const dataKey = makeDataKey();

    const contexts: BrowserContext[] = [];
    try {
      const contextA = await browser.newContext();
      const contextB = await browser.newContext();
      contexts.push(contextA, contextB);
      const deviceA = await openDevice(contextA, { token, accountId, dataKey });
      const deviceB = await openDevice(contextB, { token, accountId, dataKey });

      // 2端末が同じ語を別内容に。**Bの方が後に書く**(=更新が新しい)
      await writeNote(deviceA, 'Aが書いた内容');
      await writeNote(deviceB, 'Bが書いた内容');
      await syncNow(deviceB);
      await syncNow(deviceA);

      // **相手の方が新しくても、Aのノートは自分の内容のまま**
      await deviceA.getByRole('button', { name: '検索', exact: true }).click();
      await deviceA.getByRole('combobox', { name: '用語を検索' }).fill('TCP/IP');
      await deviceA.getByRole('option', { name: TERM_OPTION }).click();
      await expect(deviceA.getByRole('textbox', { name: 'ノート本文' })).toHaveValue('Aが書いた内容');

      // Aが「この端末の内容」で解消 → push
      await deviceA.getByRole('button', { name: '同期', exact: true }).click();
      await deviceA
        .getByTestId(/^conflict-group-/)
        .getByRole('button', { name: 'こちらを採用' })
        .first()
        .click();
      await expect(deviceA.getByRole('heading', { name: /^未解決の競合/ })).toBeHidden({ timeout: 15_000 });
      await syncNow(deviceA);

      // **解消して初めて、Bへ届く**
      await syncNow(deviceB);
      await deviceB.getByRole('button', { name: '検索', exact: true }).click();
      await deviceB.getByRole('combobox', { name: '用語を検索' }).fill('TCP/IP');
      await deviceB.getByRole('option', { name: TERM_OPTION }).click();
      await expect(deviceB.getByRole('textbox', { name: 'ノート本文' })).toHaveValue('Aが書いた内容');
    } finally {
      for (const context of contexts) await context.close();
    }
  });

});
