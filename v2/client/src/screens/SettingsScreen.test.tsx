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
    // AI設定セクションにも同じ文言の誘導ボタンがある(未ログイン時はどちらもonGoToSyncへ)ため、
    // ライセンスセクション側(先頭)のボタンを指定してクリックする。
    fireEvent.click(screen.getAllByRole('button', { name: '同期タブへ' })[0]);
    expect(onGoToSync).toHaveBeenCalled();
  });

  describe('ライセンス購入モック', () => {
    function stubAuthAndLicenseFetch(overrides: {
      licensed?: boolean;
      purchase?: { status: number; body: unknown };
      activate?: { status: number; body: unknown };
    } = {}) {
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/api/auth/me') {
          return Promise.resolve(
            jsonResponse(200, { accountId: 'acc-1', email: 'a@example.com', licensed: overrides.licensed ?? false }),
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
        throw new Error(`unexpected url: ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

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

    it('ライセンス有効時は端末内保存のライセンスコードとお支払い方法を表示し、カード変更に遷移できる', async () => {
      localStorage.setItem('it-index-v2:token', 'tok-1');
      localStorage.setItem('it-index-v2:license-code', 'ABCD-1234');
      localStorage.setItem(
        'it-index-v2:mock-payment-method',
        JSON.stringify({ brand: 'visa', last4: '4242', expiry: '12/29', holderName: 'TARO YAMADA' }),
      );
      stubAuthAndLicenseFetch({ licensed: true });
      const onGoToCheckout = vi.fn();

      renderSettingsScreen(undefined, onGoToCheckout);

      expect(await screen.findByText('ライセンス有効')).toBeTruthy();
      expect(screen.getByTestId('license-code').textContent).toBe('ABCD-1234');
      expect(screen.getByText('VISA')).toBeTruthy();
      expect(screen.getByText('•••• 4242')).toBeTruthy();
      expect(screen.getByText('有効期限 12/29')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'カードを変更する' }));
      expect(onGoToCheckout).toHaveBeenCalledWith('change-card');
    });

    it('ライセンス有効だが端末内にカードが無い場合はカードを登録するを出す(コード有効化した端末等)', async () => {
      localStorage.setItem('it-index-v2:token', 'tok-1');
      stubAuthAndLicenseFetch({ licensed: true });
      const onGoToCheckout = vi.fn();

      renderSettingsScreen(undefined, onGoToCheckout);

      expect(await screen.findByText('ライセンス有効')).toBeTruthy();
      expect(screen.getByText('登録されているカードはありません(モック決済)')).toBeTruthy();
      expect(screen.queryByTestId('license-code')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'カードを登録する' }));
      expect(onGoToCheckout).toHaveBeenCalledWith('change-card');
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

  describe('接続先サーバー', () => {
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
