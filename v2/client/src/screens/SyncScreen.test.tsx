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
  describe('自分のAPIキー', () => {
    const CREDENTIAL_KEY = 'it-index-v2:ai-credential';

    /** /api/auth/me は常に成功させ、/api/ai/test だけ呼び出しごとに応答を差し替える */
    function stubFetch(testResponses: Array<{ status: number; body: unknown }>) {
      let index = 0;
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/api/ai/test') {
          const next = testResponses[index++] ?? { status: 500, body: {} };
          return Promise.resolve(jsonResponse(next.status, next.body));
        }
        return Promise.resolve(jsonResponse(200, { accountId: 'acc-1', email: 'a@example.com' }));
      });
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    async function renderAuthed(testResponses: Array<{ status: number; body: unknown }> = []) {
      localStorage.setItem('it-index-v2:token', 'tok-1');
      const fetchMock = stubFetch(testResponses);
      renderSyncScreen();
      await waitFor(() => expect(screen.getByText(/ログイン中: a@example.com/)).toBeTruthy());
      return fetchMock;
    }

    function storedCredential(): Record<string, unknown> | null {
      const raw = localStorage.getItem(CREDENTIAL_KEY);
      return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
    }

    it('接続テスト成功時にプロバイダ・モデルごと保存し、検証済みとして表示する', async () => {
      const fetchMock = await renderAuthed([
        {
          status: 200,
          body: { ok: true, provider: 'anthropic', model: 'claude-sonnet-5', usage: { inputTokens: 2, outputTokens: 1 } },
        },
      ]);

      expect(screen.getByTestId('api-key-status').textContent).toContain('未設定');
      // 未設定のうちは削除ボタンを押せない
      expect((screen.getByRole('button', { name: '削除する' }) as HTMLButtonElement).disabled).toBe(true);

      const input = screen.getByLabelText('APIキー') as HTMLInputElement;
      expect(input.type).toBe('password');

      fireEvent.change(screen.getByLabelText('プロバイダ'), { target: { value: 'anthropic' } });
      fireEvent.change(input, { target: { value: 'sk-ant-1234567890' } });
      fireEvent.change(screen.getByLabelText('モデル名(任意)'), { target: { value: 'claude-sonnet-5' } });
      fireEvent.click(screen.getByRole('button', { name: '接続テスト' }));

      await waitFor(() => expect(screen.getByTestId('api-key-status').textContent).toContain('検証済み'));
      expect(screen.getByText(/接続できました\(Anthropic・claude-sonnet-5\)/)).toBeTruthy();
      expect(storedCredential()).toEqual({
        key: 'sk-ant-1234567890',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        verified: true,
      });
      // 接続テストのリクエストにプロバイダとモデルが載っている
      const testCall = fetchMock.mock.calls.find((call) => call[0] === '/api/ai/test');
      expect(testCall).toBeTruthy();
      expect(JSON.parse(testCall?.[1].body as string)).toEqual({
        apiKey: 'sk-ant-1234567890',
        apiProvider: 'anthropic',
        model: 'claude-sonnet-5',
      });
      // キー本体は画面に再表示しない(入力欄も空に戻し、マスク表示のみ残す)
      expect(input.value).toBe('');
      expect(screen.getByTestId('api-key-status').textContent).not.toContain('1234567890');

      fireEvent.click(screen.getByRole('button', { name: '削除する' }));

      await waitFor(() => expect(screen.getByTestId('api-key-status').textContent).toContain('未設定'));
      expect(storedCredential()).toBeNull();
    });

    it('接続テスト失敗時は保存せず、サーバーの日本語messageを表示する', async () => {
      await renderAuthed([
        {
          status: 400,
          body: { error: { code: 'user_api_key_invalid', message: '設定したAPIキーが無効です。設定画面で確認してください' } },
        },
      ]);

      fireEvent.change(screen.getByLabelText('APIキー'), { target: { value: 'sk-bad-key' } });
      fireEvent.click(screen.getByRole('button', { name: '接続テスト' }));

      await waitFor(() =>
        expect(screen.getByText('設定したAPIキーが無効です。設定画面で確認してください')).toBeTruthy(),
      );
      expect(storedCredential()).toBeNull();
      expect(screen.getByTestId('api-key-status').textContent).toContain('未設定');
    });

    it('保存済みの資格情報はマウント時に検証済みとして復元される(プロバイダ・モデルも)', async () => {
      localStorage.setItem(
        CREDENTIAL_KEY,
        JSON.stringify({ key: 'sk-saved-9876543210', provider: 'anthropic', model: 'claude-x', verified: true }),
      );
      await renderAuthed();

      const status = screen.getByTestId('api-key-status').textContent ?? '';
      expect(status).toContain('検証済み');
      expect(status).toContain('Anthropic');
      expect(status).toContain('claude-x');
      expect(status).not.toContain('9876543210');
      expect((screen.getByLabelText('プロバイダ') as HTMLSelectElement).value).toBe('anthropic');
      expect((screen.getByLabelText('モデル名(任意)') as HTMLInputElement).value).toBe('claude-x');
    });

    it('検証済みフラグが外れている場合は未検証として表示する', async () => {
      localStorage.setItem(
        CREDENTIAL_KEY,
        JSON.stringify({ key: 'sk-saved-9876543210', provider: 'openai', verified: false }),
      );
      await renderAuthed();

      expect(screen.getByTestId('api-key-status').textContent).toContain('未検証');
    });

    it('旧キー(PR #87形式)は検証済みのOpenAI設定として移行される', async () => {
      localStorage.setItem('it-index-v2:openai-key', 'sk-legacy-1234567890');
      await renderAuthed();

      const status = screen.getByTestId('api-key-status').textContent ?? '';
      expect(status).toContain('検証済み');
      expect(status).toContain('OpenAI');
      expect(localStorage.getItem('it-index-v2:openai-key')).toBeNull();
      expect(storedCredential()?.key).toBe('sk-legacy-1234567890');
    });

    it('端末保存・支出上限・OpenAI以外は品質を保証しないことを案内する', async () => {
      await renderAuthed();

      expect(screen.getByText(/この端末にのみ保存され/)).toBeTruthy();
      expect(screen.getByText(/回数上限なし/)).toBeTruthy();
      expect(screen.getByText(/支出上限\(Monthly budget\)を設定してください/)).toBeTruthy();
      expect(screen.getByText(/OpenAI以外のプロバイダは実動作の確認をしていません/)).toBeTruthy();
      expect(screen.getByText(/空欄ならプロバイダごとの既定モデルを使います/)).toBeTruthy();
    });
  });
});
