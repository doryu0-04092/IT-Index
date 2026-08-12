import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ApiKeySection from './ApiKeySection';

// 利用者持ち込みキー(BYOK)の設定セクション。docs/v2/architecture.md §5。
// v1 ApiKeyPrompt.tsxと同じ2段階(キー入力→一覧取得→モデル選択)になっているため、
// 「接続テスト」はPOST /api/ai/models(一覧取得が疎通確認を兼ねる)を呼ぶ前提で検証する。

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

  function stubFetch(responses: Array<{ status: number; body: unknown }>) {
    let index = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      const next = responses[index++] ?? { status: 500, body: {} };
      return Promise.resolve(jsonResponse(next.status, next.body));
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function storedCredential(): Record<string, unknown> | null {
    const raw = localStorage.getItem(CREDENTIAL_KEY);
    return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
  }

  function modelSelect(): HTMLSelectElement {
    return screen.getByLabelText('モデル') as HTMLSelectElement;
  }

  it('接続テストで一覧を取得し、モデルはリストボックスで選ばせる(既定はgpt-5.6-luna)', async () => {
    const fetchMock = stubFetch([
      { status: 200, body: { provider: 'openai', models: ['chatgpt-4o-latest', 'gpt-4.1-mini', 'gpt-5.6-luna'] } },
    ]);
    render(<ApiKeySection token="tok-1" />);

    expect(screen.getByTestId('api-key-status').textContent).toContain('未設定');
    // 一覧を取る前はモデルの選択肢を出さない(推測でモデル名を入れさせない)
    expect(screen.queryByLabelText('モデル')).toBeNull();
    expect((screen.getByRole('button', { name: '削除する' }) as HTMLButtonElement).disabled).toBe(true);

    const input = screen.getByLabelText('APIキー') as HTMLInputElement;
    expect(input.type).toBe('password');
    fireEvent.change(input, { target: { value: 'sk-openai-1234567890' } });
    fireEvent.click(screen.getByRole('button', { name: '接続テスト' }));

    await waitFor(() => expect(screen.getByTestId('api-key-status').textContent).toContain('検証済み'));

    // 接続テストはモデル一覧のエンドポイントを呼ぶ(/api/ai/testはUIからは呼ばない)
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe('/api/ai/models');
    expect(JSON.parse(call[1].body as string)).toEqual({
      apiKey: 'sk-openai-1234567890',
      apiProvider: 'openai',
    });
    expect(fetchMock.mock.calls.some((c) => c[0] === '/api/ai/test')).toBe(false);

    // 一覧はリストボックスとして表示され、既定はgpt-5.6-luna
    const select = modelSelect();
    expect(select.value).toBe('gpt-5.6-luna');
    expect([...select.options].map((o) => o.value)).toEqual([
      'chatgpt-4o-latest',
      'gpt-4.1-mini',
      'gpt-5.6-luna',
    ]);
    // 一覧ごと保存される(以後は問い合わせ直さずに変更できる)
    expect(storedCredential()).toEqual({
      key: 'sk-openai-1234567890',
      provider: 'openai',
      model: 'gpt-5.6-luna',
      models: ['chatgpt-4o-latest', 'gpt-4.1-mini', 'gpt-5.6-luna'],
      verified: true,
    });
    // キー本体は画面に残さない
    expect(input.value).toBe('');
    expect(screen.getByTestId('api-key-status').textContent).not.toContain('1234567890');
  });

  it('Anthropicの既定はHaiku系(一覧の並び=新しい順で最初のもの)', async () => {
    stubFetch([
      { status: 200, body: { provider: 'anthropic', models: ['claude-sonnet-5', 'claude-haiku-5', 'claude-3-5-haiku-latest'] } },
    ]);
    render(<ApiKeySection token="tok-1" />);

    fireEvent.change(screen.getByLabelText('プロバイダ'), { target: { value: 'anthropic' } });
    fireEvent.change(screen.getByLabelText('APIキー'), { target: { value: 'sk-ant-1234567890' } });
    fireEvent.click(screen.getByRole('button', { name: '接続テスト' }));

    await waitFor(() => expect(modelSelect().value).toBe('claude-haiku-5'));
    expect(storedCredential()?.model).toBe('claude-haiku-5');
  });

  it('保存済みのモデルはいつでも一覧から変更でき、その時点で保存される', async () => {
    localStorage.setItem(
      CREDENTIAL_KEY,
      JSON.stringify({
        key: 'sk-saved-9876543210',
        provider: 'openai',
        model: 'gpt-5.6-luna',
        models: ['gpt-4.1-mini', 'gpt-5.6-luna'],
        verified: true,
      }),
    );
    render(<ApiKeySection token="tok-1" />);

    // 保存済みでもモデルのリストボックスは出続ける(再テスト無しで変更できる)
    expect(modelSelect().value).toBe('gpt-5.6-luna');

    fireEvent.change(modelSelect(), { target: { value: 'gpt-4.1-mini' } });

    expect(storedCredential()?.model).toBe('gpt-4.1-mini');
    expect(screen.getByText('モデルを gpt-4.1-mini に変更し、保存いたしました。')).toBeTruthy();
    expect(screen.getByTestId('api-key-status').textContent).toContain('gpt-4.1-mini');
  });

  it('保存済みのモデルが一覧に無い場合は先頭に足して表示する', () => {
    localStorage.setItem(
      CREDENTIAL_KEY,
      JSON.stringify({
        key: 'sk-saved-9876543210',
        provider: 'openai',
        model: 'gpt-legacy-model',
        models: ['gpt-4.1-mini', 'gpt-5.6-luna'],
        verified: true,
      }),
    );
    render(<ApiKeySection token="tok-1" />);

    const select = modelSelect();
    expect(select.value).toBe('gpt-legacy-model');
    expect([...select.options].map((o) => o.value)).toEqual([
      'gpt-legacy-model',
      'gpt-4.1-mini',
      'gpt-5.6-luna',
    ]);
  });

  it('一覧が0件の場合だけモデル名の直接入力にフォールバックし、入力は即時保存される', async () => {
    stubFetch([{ status: 200, body: { provider: 'openai', models: [] } }]);
    render(<ApiKeySection token="tok-1" />);

    fireEvent.change(screen.getByLabelText('APIキー'), { target: { value: 'sk-openai-1234567890' } });
    fireEvent.click(screen.getByRole('button', { name: '接続テスト' }));

    const manual = await waitFor(
      () => screen.getByLabelText('モデル名(一覧を取得できませんでしたので直接ご入力ください)') as HTMLInputElement,
    );
    expect(screen.queryByLabelText('モデル')).toBeNull();
    expect(storedCredential()?.model).toBeUndefined();

    fireEvent.change(manual, { target: { value: 'gpt-4.1-mini' } });

    expect(storedCredential()?.model).toBe('gpt-4.1-mini');
    expect(screen.getByText('空欄の場合は、プロバイダごとの既定のモデルを使用いたします。')).toBeTruthy();
  });

  it('models無しの旧保存データは壊さず読み、再テストで一覧を取れることを案内する', () => {
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
    // 一覧が無いので選択肢は出さず、取得方法を案内する
    expect(screen.queryByLabelText('モデル')).toBeNull();
    expect(
      screen.getByText('接続テストを再度実行いただきますと、お選びいただけるモデルの一覧を取得いたします。'),
    ).toBeTruthy();
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
    expect(screen.queryByLabelText('モデル')).toBeNull();
    expect(screen.getByTestId('api-key-status').textContent).toContain('未設定');
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

  it('削除すると共有のキーに戻る', async () => {
    localStorage.setItem(
      CREDENTIAL_KEY,
      JSON.stringify({ key: 'sk-saved-9876543210', provider: 'openai', model: 'gpt-5.6-luna', models: ['gpt-5.6-luna'], verified: true }),
    );
    render(<ApiKeySection token="tok-1" />);

    fireEvent.click(screen.getByRole('button', { name: '削除する' }));

    await waitFor(() => expect(screen.getByTestId('api-key-status').textContent).toContain('未設定'));
    expect(storedCredential()).toBeNull();
    expect(screen.queryByLabelText('モデル')).toBeNull();
    expect(
      screen.getByText(
        'お客様のAPIキーを削除いたしました。以降は共有のキー(1日あたりの回数上限があります)で実行されます。',
      ),
    ).toBeTruthy();
  });

  // 文言(依頼者指摘により敬語へ全面見直し)。伝える事実は変えていないため、
  // 事実ごとの案内が残っていることを確認する。
  it('端末保存・支出上限・OpenAI以外は品質を保証しないことを丁寧な文面で案内する', () => {
    render(<ApiKeySection token="tok-1" />);

    expect(screen.getByText(/キーはこの端末にのみ保存され、サーバーには保存されません/)).toBeTruthy();
    expect(screen.getByText(/回数の上限なくAIチャットをご利用いただけます/)).toBeTruthy();
    expect(screen.getByText(/共有のキー\(1日あたりの回数上限があります\)で動作します/)).toBeTruthy();
    expect(screen.getByText(/支出上限\(Monthly budget\)を必ずご設定ください/)).toBeTruthy();
    expect(
      screen.getByText(/OpenAI以外のプロバイダにつきましては、実動作の確認ができておりません/),
    ).toBeTruthy();
    expect(screen.getByText(/応答品質は保証いたしかねます/)).toBeTruthy();
    expect(
      screen.getByText(/接続テストでは、ご入力いただいたキーでお使いになれるモデルの一覧を取得いたします/),
    ).toBeTruthy();
  });
});
