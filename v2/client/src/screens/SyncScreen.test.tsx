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
});
