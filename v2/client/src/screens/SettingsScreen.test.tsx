import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ItIndexDB } from '../db';
import { clearServerBaseUrl, getServerBaseUrl, setServerBaseUrl } from '../sync/serverConfig';
import SettingsScreen from './SettingsScreen';

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

function renderSettingsScreen(
  onGoToSync: () => void = () => {},
  onGoToCheckout: (intent: 'purchase' | 'change-card') => void = () => {},
) {
  const db = new ItIndexDB(`test-settingsscreen-${Math.random()}`);
  render(
    <SettingsScreen
      db={db}
      themeChoice="system"
      onThemeChange={() => {}}
      onGoToSync={onGoToSync}
      onGoToCheckout={onGoToCheckout}
    />,
  );
  return db;
}

describe('SettingsScreen', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    clearServerBaseUrl();
  });

  it('未ログイン時はライセンスの購入にログインが必要と案内し、同期タブへ誘導する', async () => {
    const onGoToSync = vi.fn();
    renderSettingsScreen(onGoToSync);

    expect(await screen.findByText('ライセンスの購入にはログインが必要です。')).toBeTruthy();
    // APIキー設定セクションにも同じ文言の誘導ボタンがある(未ログイン時はどちらもonGoToSyncへ)ため、
    // ライセンスセクション側(先頭)のボタンを指定してクリックする。
    fireEvent.click(screen.getAllByRole('button', { name: '同期タブへ' })[0]);
    expect(onGoToSync).toHaveBeenCalled();
  });

  describe('ライセンス購入モック', () => {
    /** ライセンス・カード・課金日はすべて/api/auth/me由来(端末内保存は持たない) */
    function stubAuthAndLicenseFetch(
      overrides: {
        licensed?: boolean;
        licenseCode?: string | null;
        licenseSource?: 'purchase' | 'operator' | null;
        activatedAt?: number | null;
        paymentMethod?: unknown;
        purchase?: { status: number; body: unknown };
        activate?: { status: number; body: unknown };
        cancel?: { status: number; body: unknown };
      } = {},
    ) {
      const licensed = overrides.licensed ?? false;
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/api/auth/me') {
          return Promise.resolve(
            jsonResponse(200, {
              accountId: 'acc-1',
              email: 'a@example.com',
              licensed,
              licenseCode: overrides.licenseCode ?? null,
              licenseSource: overrides.licenseSource ?? (licensed ? 'purchase' : null),
              activatedAt: overrides.activatedAt ?? null,
              paymentMethod: overrides.paymentMethod ?? null,
            }),
          );
        }
        if (url === '/api/license/purchase') {
          const r = overrides.purchase ?? { status: 201, body: { code: 'ABCD-1234', activatedAt: 1000 } };
          return Promise.resolve(jsonResponse(r.status, r.body));
        }
        if (url === '/api/license/activate') {
          const r = overrides.activate ?? { status: 200, body: { activatedAt: 2000 } };
          return Promise.resolve(jsonResponse(r.status, r.body));
        }
        if (url === '/api/license/cancel') {
          const r = overrides.cancel ?? { status: 200, body: { canceled: true } };
          return Promise.resolve(jsonResponse(r.status, r.body));
        }
        throw new Error(`unexpected url: ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    const VISA_CARD = { brand: 'visa', last4: '4242', expiry: '12/29', holderName: 'TARO YAMADA' };

    it('未ライセンス時は商品カードを表示し、購入手続きへでチェックアウトに遷移する', async () => {
      localStorage.setItem('it-index-v2:token', 'tok-1');
      stubAuthAndLicenseFetch({ licensed: false });
      const onGoToCheckout = vi.fn();

      renderSettingsScreen(undefined, onGoToCheckout);

      expect(await screen.findByText('IT-Index プレミアム 月額¥300')).toBeTruthy();
      expect(screen.getByText('モック決済です。実際の課金は発生しません')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: '購入手続きへ' }));
      expect(onGoToCheckout).toHaveBeenCalledWith('purchase');
    });

    it('ヘルプでプランの説明モーダルを開閉できる(未ライセンス時)(#151)', async () => {
      localStorage.setItem('it-index-v2:token', 'tok-1');
      stubAuthAndLicenseFetch({ licensed: false });

      renderSettingsScreen();
      await screen.findByText('IT-Index プレミアム 月額¥300');

      // 開く前は説明を出さない
      expect(screen.queryByText('IT-Index プレミアムとは')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'このプランでできること' }));
      expect(screen.getByText('IT-Index プレミアムとは')).toBeTruthy();
      // 月額サブスクであることと、購入で使えるようになる機能を明示する
      expect(screen.getByText('月額制のサブスクリプション')).toBeTruthy();
      expect(screen.getByText('端末間同期')).toBeTruthy();
      expect(screen.getByText('APIキーなしでのAI利用')).toBeTruthy();

      // ✕(aria-label)とフッターの「閉じる」の2つがあるため、後者(フッター側)で閉じる
      fireEvent.click(screen.getAllByRole('button', { name: '閉じる' })[1]);
      expect(screen.queryByText('IT-Index プレミアムとは')).toBeNull();
    });

    it('ヘルプはライセンス有効時にも開ける(何に支払っているかの確認)(#151)', async () => {
      localStorage.setItem('it-index-v2:token', 'tok-1');
      stubAuthAndLicenseFetch({ licensed: true, licenseCode: 'ABCD-1234', paymentMethod: VISA_CARD });

      renderSettingsScreen();
      await screen.findByText('ライセンス有効');

      fireEvent.click(screen.getByRole('button', { name: 'このプランでできること' }));
      expect(screen.getByText('IT-Index プレミアムとは')).toBeTruthy();
    });

    it('別端末でもサーバー由来のライセンスコードとお支払い方法を表示する(端末内保存に依存しない)', async () => {
      // この不具合の再現条件そのもの: localStorageにカード情報が一切無い端末
      localStorage.setItem('it-index-v2:token', 'tok-1');
      stubAuthAndLicenseFetch({
        licensed: true,
        licenseCode: 'ABCD-1234',
        licenseSource: 'purchase',
        paymentMethod: VISA_CARD,
      });
      const onGoToCheckout = vi.fn();

      renderSettingsScreen(undefined, onGoToCheckout);

      expect(await screen.findByText('ライセンス有効')).toBeTruthy();
      expect(screen.getByTestId('license-code').textContent).toBe('ABCD-1234');
      expect(screen.getByText('VISA')).toBeTruthy();
      expect(screen.getByText('•••• 4242')).toBeTruthy();
      expect(screen.getByText('有効期限 12/29')).toBeTruthy();
      // どのカードから引き落とされているかを言い切る(本人要望)
      expect(
        screen.getByText('このカードから毎月引き落とされます(モック決済のため実際の課金はありません)'),
      ).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'カードを変更する' }));
      expect(onGoToCheckout).toHaveBeenCalledWith('change-card');
    });

    it('有効期限が切れたカードは警告し、引き落としの案内を出さない(#147)', async () => {
      localStorage.setItem('it-index-v2:token', 'tok-1');
      vi.setSystemTime(new Date(2026, 7, 20));
      stubAuthAndLicenseFetch({
        licensed: true,
        licenseSource: 'purchase',
        // 2020年1月末で切れているカード
        paymentMethod: { ...VISA_CARD, expiry: '01/20' },
      });

      renderSettingsScreen();

      expect(await screen.findByTestId('card-expired-warning')).toBeTruthy();
      expect(
        screen.getByText(
          'このカードは有効期限が切れています。引き落としができないため、カードを変更してください。',
        ),
      ).toBeTruthy();
      // 使えないカードに「毎月引き落とされます」と言い切らない(表示の矛盾を作らない)
      expect(
        screen.queryByText(
          'このカードから毎月引き落とされます(モック決済のため実際の課金はありません)',
        ),
      ).toBeNull();
      vi.useRealTimers();
    });

    it('有効期限内のカードでは警告を出さない(#147)', async () => {
      localStorage.setItem('it-index-v2:token', 'tok-1');
      vi.setSystemTime(new Date(2026, 7, 20));
      stubAuthAndLicenseFetch({
        licensed: true,
        licenseSource: 'purchase',
        paymentMethod: VISA_CARD, // 12/29
      });

      renderSettingsScreen();

      expect(await screen.findByText('ライセンス有効')).toBeTruthy();
      expect(screen.queryByTestId('card-expired-warning')).toBeNull();
      expect(
        screen.getByText(
          'このカードから毎月引き落とされます(モック決済のため実際の課金はありません)',
        ),
      ).toBeTruthy();
      vi.useRealTimers();
    });

    it('購入経路なのにカードが無い場合は異常として案内し、登録導線を出す', async () => {
      localStorage.setItem('it-index-v2:token', 'tok-1');
      stubAuthAndLicenseFetch({ licensed: true, licenseSource: 'purchase', paymentMethod: null });
      const onGoToCheckout = vi.fn();

      renderSettingsScreen(undefined, onGoToCheckout);

      expect(await screen.findByText('ライセンス有効')).toBeTruthy();
      expect(screen.getByText('お支払い方法を確認できませんでした。カードを登録してください。')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'カードを登録する' }));
      expect(onGoToCheckout).toHaveBeenCalledWith('change-card');
    });

    it('運営者コードで有効化した場合はカード欄・請求日・解約を出さない(不具合と誤解させない)', async () => {
      localStorage.setItem('it-index-v2:token', 'tok-1');
      stubAuthAndLicenseFetch({
        licensed: true,
        licenseCode: 'ITX-FREE-0001',
        licenseSource: 'operator',
        activatedAt: Date.UTC(2026, 7, 18),
      });

      renderSettingsScreen();

      expect(await screen.findByText('ライセンス有効')).toBeTruthy();
      expect(screen.getByText('コードで有効化済み(カード登録なし)')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'カードを登録する' })).toBeNull();
      expect(screen.queryByTestId('billing-schedule')).toBeNull();
      expect(screen.queryByRole('button', { name: '解約する' })).toBeNull();
    });

    it('購入経路では課金開始日と次回請求日を表示する', async () => {
      localStorage.setItem('it-index-v2:token', 'tok-1');
      // ローカル時刻で2026-08-18に固定(表示は年月日のみ)
      const activatedAt = new Date(2026, 7, 18, 12, 0, 0).getTime();
      vi.setSystemTime(new Date(2026, 7, 20));
      stubAuthAndLicenseFetch({
        licensed: true,
        licenseSource: 'purchase',
        activatedAt,
        paymentMethod: VISA_CARD,
      });

      renderSettingsScreen();

      const schedule = await screen.findByTestId('billing-schedule');
      expect(schedule.textContent).toContain('2026年8月18日');
      expect(schedule.textContent).toContain('2026年9月18日');
      vi.useRealTimers();
    });

    it('コード有効化: 成功するとライセンス有効表示になる', async () => {
      localStorage.setItem('it-index-v2:token', 'tok-1');
      const fetchMock = stubAuthAndLicenseFetch({ licensed: false });

      renderSettingsScreen();
      await screen.findByText('コードをお持ちの方');

      fireEvent.change(screen.getByLabelText('ライセンスコード'), { target: { value: 'CODE-1' } });
      fireEvent.click(screen.getByRole('button', { name: '有効化する' }));

      await waitFor(() => expect(screen.getByText('ライセンス有効')).toBeTruthy());
      const activateCall = fetchMock.mock.calls.find((c) => c[0] === '/api/license/activate');
      expect(JSON.parse(activateCall?.[1].body as string)).toEqual({ code: 'CODE-1' });
    });

    it('コード有効化: 失敗時はサーバーの日本語messageを表示し、有効化画面のまま', async () => {
      localStorage.setItem('it-index-v2:token', 'tok-1');
      stubAuthAndLicenseFetch({
        licensed: false,
        activate: {
          status: 403,
          body: { error: { code: 'license_invalid', message: 'ライセンスコードが正しくありません。入力内容を確認してください' } },
        },
      });

      renderSettingsScreen();
      await screen.findByText('コードをお持ちの方');

      fireEvent.change(screen.getByLabelText('ライセンスコード'), { target: { value: 'bad-code' } });
      fireEvent.click(screen.getByRole('button', { name: '有効化する' }));

      await waitFor(() =>
        expect(screen.getByText('ライセンスコードが正しくありません。入力内容を確認してください')).toBeTruthy(),
      );
      expect(screen.getByText('IT-Index プレミアム 月額¥300')).toBeTruthy();
    });

    it('ライセンス有効時はライセンス有効表示のみで、コードは再表示しない', async () => {
      localStorage.setItem('it-index-v2:token', 'tok-1');
      stubAuthAndLicenseFetch({ licensed: true });

      renderSettingsScreen();

      expect(await screen.findByText('ライセンス有効')).toBeTruthy();
      expect(screen.queryByText('IT-Index プレミアム 月額¥300')).toBeNull();
    });
  });

  describe('解約', () => {
    /** 上のstubAuthAndLicenseFetchと同じ形。解約は購入経路でのみ表示される */
    function stubLicensedAccount(cancel?: { status: number; body: unknown }) {
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/api/auth/me') {
          return Promise.resolve(
            jsonResponse(200, {
              accountId: 'acc-1',
              email: 'a@example.com',
              licensed: true,
              licenseCode: 'ABCD-1234',
              licenseSource: 'purchase',
              activatedAt: Date.now(),
              paymentMethod: { brand: 'visa', last4: '4242', expiry: '12/29', holderName: 'TARO YAMADA' },
            }),
          );
        }
        if (url === '/api/license/cancel') {
          const r = cancel ?? { status: 200, body: { canceled: true } };
          return Promise.resolve(jsonResponse(r.status, r.body));
        }
        throw new Error(`unexpected url: ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    it('確認文字列が一致するまで実行できない(二重確認)', async () => {
      localStorage.setItem('it-index-v2:token', 'tok-1');
      stubLicensedAccount();

      renderSettingsScreen();

      // 1段目: 押すまで確認欄は現れない
      const openButton = await screen.findByRole('button', { name: '解約する' });
      expect(screen.queryByLabelText('確認文字列')).toBeNull();
      fireEvent.click(openButton);

      // 2段目: 何が起きるかを明示した上で、確認文字列の完全一致を求める
      expect(screen.getByText(/すぐに使えなくなります/)).toBeTruthy();
      expect(screen.getByText(/再利用できません/)).toBeTruthy();
      const executeButton = screen.getByRole('button', { name: '解約を実行する' }) as HTMLButtonElement;
      expect(executeButton.disabled).toBe(true);

      fireEvent.change(screen.getByLabelText('確認文字列'), { target: { value: '解約' } });
      expect(executeButton.disabled).toBe(true);

      fireEvent.change(screen.getByLabelText('確認文字列'), { target: { value: '解約する' } });
      expect(executeButton.disabled).toBe(false);
    });

    it('解約に成功すると未ライセンス表示(購入導線)へ戻る', async () => {
      localStorage.setItem('it-index-v2:token', 'tok-1');
      const fetchMock = stubLicensedAccount();

      renderSettingsScreen();

      fireEvent.click(await screen.findByRole('button', { name: '解約する' }));
      fireEvent.change(screen.getByLabelText('確認文字列'), { target: { value: '解約する' } });
      fireEvent.click(screen.getByRole('button', { name: '解約を実行する' }));

      await waitFor(() => expect(screen.getByText('IT-Index プレミアム 月額¥300')).toBeTruthy());
      expect(fetchMock.mock.calls.some((c) => c[0] === '/api/license/cancel')).toBe(true);
      // 解約セクション自体も消える(未ライセンスには解約する対象が無い)
      expect(screen.queryByRole('button', { name: '解約する' })).toBeNull();
    });

    it('解約に失敗した場合はライセンス有効のままエラーを表示する', async () => {
      localStorage.setItem('it-index-v2:token', 'tok-1');
      stubLicensedAccount({
        status: 409,
        body: { error: { code: 'license_not_active', message: '解約できる有効なライセンスがありません' } },
      });

      renderSettingsScreen();

      fireEvent.click(await screen.findByRole('button', { name: '解約する' }));
      fireEvent.change(screen.getByLabelText('確認文字列'), { target: { value: '解約する' } });
      fireEvent.click(screen.getByRole('button', { name: '解約を実行する' }));

      await waitFor(() => expect(screen.getByText(/解約できる有効なライセンスがありません/)).toBeTruthy());
      expect(screen.getByText('ライセンス有効')).toBeTruthy();
    });

    it('やめるで確認欄が閉じ、入力内容が消える', async () => {
      localStorage.setItem('it-index-v2:token', 'tok-1');
      stubLicensedAccount();

      renderSettingsScreen();

      fireEvent.click(await screen.findByRole('button', { name: '解約する' }));
      fireEvent.change(screen.getByLabelText('確認文字列'), { target: { value: '解約する' } });
      fireEvent.click(screen.getByRole('button', { name: 'やめる' }));

      expect(screen.queryByLabelText('確認文字列')).toBeNull();
      expect(screen.getByRole('button', { name: '解約する' })).toBeTruthy();
    });
  });

  describe('接続先サーバー', () => {
    it('ヘルプで「接続先サーバーとは」の説明モーダルを開閉できる(#163)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, { error: { code: 'unauthorized', message: '認証が必要です' } })));
      renderSettingsScreen();
      await screen.findByText('接続先サーバー');

      expect(screen.queryByText('接続先サーバーとは')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'この設定について' }));

      expect(screen.getByText('接続先サーバーとは')).toBeTruthy();
      // 何のためのサーバーか・通常は変更不要・辞書機能はサーバー無しでも動くことを明示する
      expect(screen.getByText(/端末間同期の中継/)).toBeTruthy();
      expect(screen.getByText('通常は変更不要です。')).toBeTruthy();
      expect(screen.getByText(/サーバーに接続しなくても動きます/)).toBeTruthy();

      // ✕(aria-label)とフッターの「閉じる」の2つがあるため、後者で閉じる
      fireEvent.click(screen.getAllByRole('button', { name: '閉じる' })[1]);
      expect(screen.queryByText('接続先サーバーとは')).toBeNull();
    });

    it('接続テストに成功したURLだけ保存され、基底URLに反映される', async () => {
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === 'https://self-hosted.example.workers.dev/api/health') {
          return Promise.resolve(jsonResponse(200, { status: 'ok' }));
        }
        return Promise.resolve(jsonResponse(401, { error: { code: 'unauthorized', message: '認証が必要です' } }));
      });
      vi.stubGlobal('fetch', fetchMock);

      renderSettingsScreen();
      await screen.findByText('接続先サーバー');
      expect(screen.getByTestId('server-base-status').textContent).toContain('公式(同一オリジン)');

      fireEvent.change(screen.getByLabelText('サーバーURL'), {
        target: { value: 'https://self-hosted.example.workers.dev' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'サーバー接続テスト' }));

      await waitFor(() =>
        expect(screen.getByTestId('server-base-status').textContent).toContain('https://self-hosted.example.workers.dev'),
      );
      expect(getServerBaseUrl()).toBe('https://self-hosted.example.workers.dev');
    });

    it('接続テストに失敗した場合は保存しない', async () => {
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === 'https://down.example.workers.dev/api/health') {
          return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve(null) });
        }
        return Promise.resolve(jsonResponse(401, { error: { code: 'unauthorized', message: '認証が必要です' } }));
      });
      vi.stubGlobal('fetch', fetchMock);

      renderSettingsScreen();
      await screen.findByText('接続先サーバー');

      fireEvent.change(screen.getByLabelText('サーバーURL'), { target: { value: 'https://down.example.workers.dev' } });
      fireEvent.click(screen.getByRole('button', { name: 'サーバー接続テスト' }));

      await waitFor(() => expect(screen.getByText(/接続に失敗しました/)).toBeTruthy());
      expect(getServerBaseUrl()).toBeNull();
      expect(screen.getByTestId('server-base-status').textContent).toContain('公式(同一オリジン)');
    });

    it('既定に戻すボタンで公式(同一オリジン)に戻せる', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(jsonResponse(401, { error: { code: 'unauthorized', message: '認証が必要です' } })),
      );
      setServerBaseUrl('https://already-saved.example.workers.dev');

      renderSettingsScreen();
      await waitFor(() =>
        expect(screen.getByTestId('server-base-status').textContent).toContain('https://already-saved.example.workers.dev'),
      );

      fireEvent.click(screen.getByRole('button', { name: '既定に戻す' }));

      expect(screen.getByTestId('server-base-status').textContent).toContain('公式(同一オリジン)');
      expect(getServerBaseUrl()).toBeNull();
    });
  });

  describe('データ(オールクリア)', () => {
    it('確認文字列が一致しないと実行ボタンが押せない', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(jsonResponse(401, { error: { code: 'unauthorized', message: '認証が必要です' } })),
      );
      renderSettingsScreen();

      fireEvent.click(await screen.findByRole('button', { name: 'オールクリアする' }));
      const confirmInput = screen.getByLabelText('確認文字列');
      const executeButton = screen.getByRole('button', { name: '実行する' });

      fireEvent.change(confirmInput, { target: { value: '初期化す' } });
      expect((executeButton as HTMLButtonElement).disabled).toBe(true);

      fireEvent.change(confirmInput, { target: { value: '初期化する' } });
      expect((executeButton as HTMLButtonElement).disabled).toBe(false);
    });

    it('キャンセルで確認欄が閉じ、入力内容が消える', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(jsonResponse(401, { error: { code: 'unauthorized', message: '認証が必要です' } })),
      );
      renderSettingsScreen();

      fireEvent.click(await screen.findByRole('button', { name: 'オールクリアする' }));
      fireEvent.change(screen.getByLabelText('確認文字列'), { target: { value: '初期化する' } });
      fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));

      expect(screen.queryByLabelText('確認文字列')).toBeNull();
      expect(screen.getByRole('button', { name: 'オールクリアする' })).toBeTruthy();
    });
  });
});
