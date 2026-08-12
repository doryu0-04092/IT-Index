import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ApiKeySection from './ApiKeySection';

// 利用者持ち込みキー(BYOK)の設定セクション。docs/v2/architecture.md §5。
// 元はSyncScreen.test.tsxで(ログイン状態の再現込みで)検証していたが、ApiKeySection.tsxが
// 単独コンポーネントとして抽出されたため(設定タブ新設に伴う移設)、tokenを直接渡して
// このコンポーネントだけを検証する。

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

describe('ApiKeySection', () => {
  const CREDENTIAL_KEY = 'it-index-v2:ai-credential';

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  function stubFetch(testResponses: Array<{ status: number; body: unknown }>) {
    let index = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      const next = testResponses[index++] ?? { status: 500, body: {} };
      return Promise.resolve(jsonResponse(next.status, next.body));
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function storedCredential(): Record<string, unknown> | null {
    const raw = localStorage.getItem(CREDENTIAL_KEY);
    return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
  }

  it('接続テスト成功時にプロバイダ・モデルごと保存し、検証済みとして表示する', async () => {
    const fetchMock = stubFetch([
      {
        status: 200,
        body: { ok: true, provider: 'anthropic', model: 'claude-sonnet-5', usage: { inputTokens: 2, outputTokens: 1 } },
      },
    ]);
    render(<ApiKeySection token="tok-1" />);

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
    stubFetch([
      {
        status: 400,
        body: { error: { code: 'user_api_key_invalid', message: '設定したAPIキーが無効です。設定画面で確認してください' } },
      },
    ]);
    render(<ApiKeySection token="tok-1" />);

    fireEvent.change(screen.getByLabelText('APIキー'), { target: { value: 'sk-bad-key' } });
    fireEvent.click(screen.getByRole('button', { name: '接続テスト' }));

    await waitFor(() =>
      expect(screen.getByText('設定したAPIキーが無効です。設定画面で確認してください')).toBeTruthy(),
    );
    expect(storedCredential()).toBeNull();
    expect(screen.getByTestId('api-key-status').textContent).toContain('未設定');
  });

  it('保存済みの資格情報はマウント時に検証済みとして復元される(プロバイダ・モデルも)', () => {
    localStorage.setItem(
      CREDENTIAL_KEY,
      JSON.stringify({ key: 'sk-saved-9876543210', provider: 'anthropic', model: 'claude-x', verified: true }),
    );
    render(<ApiKeySection token="tok-1" />);

    const status = screen.getByTestId('api-key-status').textContent ?? '';
    expect(status).toContain('検証済み');
    expect(status).toContain('Anthropic');
    expect(status).toContain('claude-x');
    expect(status).not.toContain('9876543210');
    expect((screen.getByLabelText('プロバイダ') as HTMLSelectElement).value).toBe('anthropic');
    expect((screen.getByLabelText('モデル名(任意)') as HTMLInputElement).value).toBe('claude-x');
  });

  it('検証済みフラグが外れている場合は未検証として表示する', () => {
    localStorage.setItem(
      CREDENTIAL_KEY,
      JSON.stringify({ key: 'sk-saved-9876543210', provider: 'openai', verified: false }),
    );
    render(<ApiKeySection token="tok-1" />);

    expect(screen.getByTestId('api-key-status').textContent).toContain('未検証');
  });

  it('旧キー(PR #87形式)は検証済みのOpenAI設定として移行される', () => {
    localStorage.setItem('it-index-v2:openai-key', 'sk-legacy-1234567890');
    render(<ApiKeySection token="tok-1" />);

    const status = screen.getByTestId('api-key-status').textContent ?? '';
    expect(status).toContain('検証済み');
    expect(status).toContain('OpenAI');
    expect(localStorage.getItem('it-index-v2:openai-key')).toBeNull();
    expect(storedCredential()?.key).toBe('sk-legacy-1234567890');
  });

  it('端末保存・支出上限・OpenAI以外は品質を保証しないことを案内する', () => {
    render(<ApiKeySection token="tok-1" />);

    expect(screen.getByText(/この端末にのみ保存され/)).toBeTruthy();
    expect(screen.getByText(/回数上限なし/)).toBeTruthy();
    expect(screen.getByText(/支出上限\(Monthly budget\)を設定してください/)).toBeTruthy();
    expect(screen.getByText(/OpenAI以外のプロバイダは実動作の確認をしていません/)).toBeTruthy();
    expect(screen.getByText(/空欄ならプロバイダごとの既定モデルを使います/)).toBeTruthy();
  });
});
