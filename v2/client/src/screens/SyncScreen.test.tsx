import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ItIndexDB } from '../db';
import { createAsksRepository } from '../repositories/asks';
import { createNoteConflictsRepository } from '../repositories/noteConflicts';
import { createNotesRepository } from '../repositories/notes';
import { createSyncStateRepository } from '../repositories/syncState';
import { createTermsRepository } from '../repositories/terms';
import SyncScreen from './SyncScreen';

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

function renderSyncScreen(deviceId: string | null = 'device-1') {
  const db = new ItIndexDB(`test-syncscreen-${Math.random()}`);
  render(
    <SyncScreen
      db={db}
      deviceId={deviceId}
      termsRepo={createTermsRepository(db)}
      notesRepo={createNotesRepository(db)}
      asksRepo={createAsksRepository(db)}
      noteConflictsRepo={createNoteConflictsRepository(db)}
      syncStateRepo={createSyncStateRepository(db)}
    />,
  );
  return db;
}

describe('SyncScreen', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('未ログイン時はログインフォームを表示する', async () => {
    renderSyncScreen();
    await waitFor(() => expect(screen.getByLabelText('メールアドレス')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'ログインする' })).toBeTruthy();
  });

  it('保存済みトークンが有効ならログイン済み表示に切り替わる', async () => {
    localStorage.setItem('it-index-v2:token', 'saved-token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { accountId: 'acc-1', email: 'saved@example.com' })));

    renderSyncScreen();

    await waitFor(() => expect(screen.getByText(/ログイン中: saved@example.com/)).toBeTruthy());
  });

  it('保存済みトークンが無効(401)なら未ログイン表示に戻し、トークンを破棄する', async () => {
    localStorage.setItem('it-index-v2:token', 'expired-token');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(401, { error: { code: 'unauthorized', message: '認証が必要です' } })),
    );

    renderSyncScreen();

    await waitFor(() => expect(screen.getByLabelText('メールアドレス')).toBeTruthy());
    expect(localStorage.getItem('it-index-v2:token')).toBeNull();
  });

  it('確認がネットワーク断で失敗してもトークンを破棄せず、ログイン状態を保つ', async () => {
    // 要件定義書§5: サーバー停止時に止まってよいのは同期だけ。トークン破棄は401のときに限る。
    localStorage.setItem('it-index-v2:token', 'saved-token');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    renderSyncScreen();

    await waitFor(() => expect(screen.getByText(/オフライン: 次の接続時に確認します/)).toBeTruthy());
    expect(localStorage.getItem('it-index-v2:token')).toBe('saved-token');
  });

  it('ログイン成功で同期操作画面に切り替わり、失敗時はサーバーの日本語messageを表示する', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      if (url === '/api/auth/login') {
        const body = JSON.parse(init.body as string);
        if (body.password === 'wrong') {
          return Promise.resolve(
            jsonResponse(401, { error: { code: 'invalid_credentials', message: 'メールアドレスまたはパスワードが正しくありません' } }),
          );
        }
        return Promise.resolve(jsonResponse(200, { token: 'tok-1' }));
      }
      if (url === '/api/auth/me') {
        return Promise.resolve(jsonResponse(200, { accountId: 'acc-1', email: 'a@example.com' }));
      }
      throw new Error(`unexpected url: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderSyncScreen();
    await waitFor(() => expect(screen.getByLabelText('メールアドレス')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('メールアドレス'), { target: { value: 'a@example.com' } });
    fireEvent.change(screen.getByLabelText('パスワード'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'ログインする' }));

    await waitFor(() => expect(screen.getByText('メールアドレスまたはパスワードが正しくありません')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('パスワード'), { target: { value: 'correct-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'ログインする' }));

    await waitFor(() => expect(screen.getByText(/ログイン中: a@example.com/)).toBeTruthy());
  });

  it('ログイン済みで「今すぐ同期」を押すとpush→pullし、結果件数を表示する', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/auth/me') return Promise.resolve(jsonResponse(200, { accountId: 'acc-1', email: 'a@example.com' }));
      if (url === '/api/sync/push') return Promise.resolve(jsonResponse(201, { seq: 1 }));
      if (url.startsWith('/api/sync/pull')) return Promise.resolve(jsonResponse(200, { blobs: [], latest: 0 }));
      throw new Error(`unexpected url: ${url}`);
    });
    localStorage.setItem('it-index-v2:token', 'tok-1');
    vi.stubGlobal('fetch', fetchMock);

    renderSyncScreen();
    await waitFor(() => expect(screen.getByText(/ログイン中: a@example.com/)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: '今すぐ同期' }));

    await waitFor(() => expect(screen.getByText(/受信0件/)).toBeTruthy());
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/sync/push')).toBe(true);
  });

  it('ログアウトでトークンを破棄し、ログインフォームに戻る', async () => {
    localStorage.setItem('it-index-v2:token', 'tok-1');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { accountId: 'acc-1', email: 'a@example.com' })));

    renderSyncScreen();
    await waitFor(() => expect(screen.getByText(/ログイン中: a@example.com/)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'ログアウト' }));

    await waitFor(() => expect(screen.getByLabelText('メールアドレス')).toBeTruthy());
    expect(localStorage.getItem('it-index-v2:token')).toBeNull();
  });

  // 利用者持ち込みキー(BYOK)の設定セクション。docs/v2/architecture.md §5。
  describe('自分のOpenAI APIキー', () => {
    async function renderAuthed() {
      localStorage.setItem('it-index-v2:token', 'tok-1');
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(jsonResponse(200, { accountId: 'acc-1', email: 'a@example.com' })),
      );
      renderSyncScreen();
      await waitFor(() => expect(screen.getByText(/ログイン中: a@example.com/)).toBeTruthy());
    }

    it('未設定→設定→削除で状態表示が遷移し、localStorageも追随する', async () => {
      await renderAuthed();

      expect(screen.getByTestId('api-key-status').textContent).toContain('未設定');
      // 未設定のうちは削除ボタンを押せない
      expect((screen.getByRole('button', { name: '削除する' }) as HTMLButtonElement).disabled).toBe(true);

      const input = screen.getByLabelText('OpenAI APIキー') as HTMLInputElement;
      expect(input.type).toBe('password');

      fireEvent.change(input, { target: { value: 'sk-user-1234567890' } });
      fireEvent.click(screen.getByRole('button', { name: '保存する' }));

      await waitFor(() => expect(screen.getByTestId('api-key-status').textContent).toContain('設定済み'));
      expect(localStorage.getItem('it-index-v2:openai-key')).toBe('sk-user-1234567890');
      // キー本体は画面に再表示しない(入力欄も空に戻し、マスク表示のみ残す)
      expect(input.value).toBe('');
      expect(screen.getByTestId('api-key-status').textContent).not.toContain('1234567890');

      fireEvent.click(screen.getByRole('button', { name: '削除する' }));

      await waitFor(() => expect(screen.getByTestId('api-key-status').textContent).toContain('未設定'));
      expect(localStorage.getItem('it-index-v2:openai-key')).toBeNull();
    });

    it('保存済みキーがあればマウント時に設定済みとして表示する', async () => {
      localStorage.setItem('it-index-v2:openai-key', 'sk-saved-9876543210');
      await renderAuthed();

      const status = screen.getByTestId('api-key-status').textContent ?? '';
      expect(status).toContain('設定済み');
      expect(status).not.toContain('9876543210');
    });

    it('端末保存であることと支出上限の設定を案内する', async () => {
      await renderAuthed();

      expect(screen.getByText(/この端末にのみ保存され/)).toBeTruthy();
      expect(screen.getByText(/回数上限なし/)).toBeTruthy();
      expect(screen.getByText(/支出上限\(Monthly budget\)を設定してください/)).toBeTruthy();
    });
  });
});
