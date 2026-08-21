import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import KeyTransferSection from './KeyTransferSection';
import { getDataKey, setDataKey } from './syncKeyStore';
import { generateDataKey, normalizeTransferCode, wrapDataKey } from './syncCrypto';

// カメラ層(getUserMedia・requestAnimationFrame)は実機依存でテスト対象外(qrScanner.ts参照)。
// ここでは「カメラの有無で選択肢の出し分けが変わる」ことだけを見たいのでモックする。
const hasCameraDevice = vi.fn<() => Promise<boolean>>();
const startQrScan = vi.fn();
vi.mock('./qrScanner', () => ({
  hasCameraDevice: () => hasCameraDevice(),
  startQrScan: (...args: unknown[]) => startQrScan(...args),
  isCameraAvailable: () => true,
}));

const ACCOUNT = 'acc-1';

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

function renderSection(undecryptableBlobs = 0) {
  render(
    <KeyTransferSection token="tok-1" accountId={ACCOUNT} undecryptableBlobs={undecryptableBlobs} />,
  );
}

/**
 * 数字コードの経路は「QRが使えない場合」の中にしまってある(2段階)。
 * その経路を試すテストは、まずここを開く必要がある。
 */
async function openFallback() {
  fireEvent.click(await screen.findByRole('button', { name: 'QRが使えない場合' }));
}

describe('KeyTransferSection', () => {
  beforeEach(() => {
    hasCameraDevice.mockResolvedValue(false);
    startQrScan.mockResolvedValue(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('カメラが無い端末では「QRを読み取る」を出さない(押して初めて失敗する状態を作らない)', async () => {
    hasCameraDevice.mockResolvedValue(false);
    renderSection();

    expect(await screen.findByRole('button', { name: 'QRを表示する(渡す側)' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'QRを読み取る(受け取る側)' })).toBeNull();
  });

  it('数字コードは最初は出さず、「QRが使えない場合」を開いた時だけ出す(2段階)', async () => {
    renderSection();
    await screen.findByRole('button', { name: 'QRを表示する(渡す側)' });

    // 横並びの対等な選択肢にすると、理由なく弱い方を選べてQRを足した意味が無くなる
    expect(screen.queryByRole('button', { name: '数字コードを表示する(渡す側)' })).toBeNull();
    expect(screen.queryByRole('button', { name: '数字コードを入力する(受け取る側)' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'QRが使えない場合' }));

    expect(screen.getByRole('button', { name: '数字コードを表示する(渡す側)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '数字コードを入力する(受け取る側)' })).toBeTruthy();
  });

  it('数字コードを開いた時に、鍵が5分サーバーに置かれることとQRを勧める旨を出す', async () => {
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'QRが使えない場合' }));

    expect(screen.getByText(/暗号化した鍵が5分間だけサーバーに置かれます/)).toBeTruthy();
    expect(screen.getByText(/鍵がサーバーを通りません/)).toBeTruthy();
  });

  it('カメラがある端末では「QRを読み取る」を出す', async () => {
    hasCameraDevice.mockResolvedValue(true);
    renderSection();

    expect(await screen.findByRole('button', { name: 'QRを読み取る(受け取る側)' })).toBeTruthy();
  });

  it('復号できなかった差分があれば、鍵が揃っていない旨とデータが失われていないことを案内する', async () => {
    renderSection(3);

    const notice = await screen.findByTestId('undecryptable-notice');
    expect(notice.textContent).toContain('3件');
    expect(notice.textContent).toContain('データは失われていません');
  });

  it('復号できた場合は案内を出さない', async () => {
    renderSection(0);

    await screen.findByRole('button', { name: 'QRを表示する(渡す側)' });
    expect(screen.queryByTestId('undecryptable-notice')).toBeNull();
  });

  it('QRを表示すると鍵が作られ、他人に見せない注意を出す', async () => {
    renderSection();

    fireEvent.click(await screen.findByRole('button', { name: 'QRを表示する(渡す側)' }));

    await waitFor(() => expect(getDataKey(ACCOUNT)).not.toBeNull());
    expect(screen.getByText('このQRには鍵そのものが入っています。他の人に見せないでください。')).toBeTruthy();
  });

  it('数字コードを表示すると、包んだ鍵だけをサーバーへ預ける(鍵もコードも送らない)', async () => {
    const dataKey = generateDataKey();
    setDataKey(ACCOUNT, dataKey);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, { expiresAt: Date.now() + 1000 }));
    vi.stubGlobal('fetch', fetchMock);

    renderSection();
    await openFallback();
    fireEvent.click(screen.getByRole('button', { name: '数字コードを表示する(渡す側)' }));

    const shown = await screen.findByTestId('issued-code');
    const code = normalizeTransferCode(shown.textContent ?? '');
    expect(code).toMatch(/^\d{8}$/);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/sync/keyshare');
    expect(init.method).toBe('PUT');
    const body = JSON.parse(init.body);
    expect(Object.keys(body).sort()).toEqual(['salt', 'wrappedDk']);
    // 鍵そのものも、表示している8桁も、リクエストに現れない
    expect(init.body).not.toContain(dataKey);
    expect(init.body).not.toContain(code);
  });

  it('正しいコードを入力すると鍵を受け取り、サーバーの預かりを消す', async () => {
    const dataKey = generateDataKey();
    const wrapped = await wrapDataKey(dataKey, '12345678');
    const fetchMock = vi.fn().mockImplementation((url: string, init: { method?: string }) => {
      if (url === '/api/sync/keyshare' && (init.method ?? 'GET') === 'GET') {
        return Promise.resolve(jsonResponse(200, wrapped));
      }
      return Promise.resolve(jsonResponse(200, { deleted: true }));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderSection();
    await openFallback();
    fireEvent.click(screen.getByRole('button', { name: '数字コードを入力する(受け取る側)' }));
    fireEvent.change(screen.getByLabelText('相手の画面に出ている8桁'), {
      target: { value: '1234 5678' }, // 区切りを入れても通る
    });
    fireEvent.click(screen.getByRole('button', { name: '鍵を受け取る' }));

    await waitFor(() => expect(getDataKey(ACCOUNT)).toBe(dataKey));
    expect(fetchMock.mock.calls.some(([, init]) => init.method === 'DELETE')).toBe(true);
  });

  it('コードが違う場合は案内を出し、鍵を保存しない', async () => {
    const wrapped = await wrapDataKey(generateDataKey(), '12345678');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, wrapped)));

    renderSection();
    await openFallback();
    fireEvent.click(screen.getByRole('button', { name: '数字コードを入力する(受け取る側)' }));
    fireEvent.change(screen.getByLabelText('相手の画面に出ている8桁'), {
      target: { value: '12345679' },
    });
    fireEvent.click(screen.getByRole('button', { name: '鍵を受け取る' }));

    expect(
      await screen.findByText('コードが違います。相手の画面に出ている8桁を確認してください。'),
    ).toBeTruthy();
    expect(getDataKey(ACCOUNT)).toBeNull();
  });

  it('期限切れ(404)は5分の有効期限が切れたことを案内する', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(404, { error: { code: 'keyshare_not_found', message: '見つかりません' } }),
      ),
    );

    renderSection();
    await openFallback();
    fireEvent.click(screen.getByRole('button', { name: '数字コードを入力する(受け取る側)' }));
    fireEvent.change(screen.getByLabelText('相手の画面に出ている8桁'), {
      target: { value: '12345678' },
    });
    fireEvent.click(screen.getByRole('button', { name: '鍵を受け取る' }));

    expect(await screen.findByText(/有効期限\(5分\)が切れています/)).toBeTruthy();
  });

  it('鍵の作り直しは二段確認で、実行すると鍵が変わりサーバー上の差分を消す', async () => {
    const before = generateDataKey();
    setDataKey(ACCOUNT, before);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { deleted: 3 }));
    vi.stubGlobal('fetch', fetchMock);

    renderSection();
    // 一段目: 押しただけでは実行されない
    fireEvent.click(await screen.findByRole('button', { name: '鍵を作り直す' }));
    expect(getDataKey(ACCOUNT)).toBe(before);
    expect(fetchMock).not.toHaveBeenCalled();

    // 二段目
    fireEvent.click(
      screen.getByRole('button', { name: '鍵を作り直してサーバー上の差分を削除する' }),
    );

    await waitFor(() => expect(getDataKey(ACCOUNT)).not.toBe(before));
    expect(getDataKey(ACCOUNT)).not.toBeNull();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/sync/blobs');
    expect(init.method).toBe('DELETE');
  });
});
