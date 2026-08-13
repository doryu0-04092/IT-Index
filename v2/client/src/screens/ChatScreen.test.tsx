import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { buildTermRecord } from '@it-index/shared';
import { ItIndexDB } from '../db';
import { createChatRepository, type ChatRepository } from '../repositories/chat';
import { createNotesRepository, type NotesRepository } from '../repositories/notes';
import { createTermsRepository, type TermsRepository } from '../repositories/terms';
import type { AiClient } from '../ai/aiClient';
import type { CommitOrchestrator } from '../ai/commitOrchestrator';
import { clearToken, setToken } from '../sync/tokenStore';
import { clearAiCredential, saveVerifiedCredential } from '../sync/apiKeyStore';
import { ApiRequestError } from '../sync/apiClient';
import ChatScreen from './ChatScreen';

// diagrams描画の実体(mermaidの実描画)はMermaidDiagram.test.tsxで検証済み。ここでは
// assistant発言が(ChatMessageBody経由で)MermaidDiagramへ渡っていることだけを確認する。
vi.mock('../lib/MermaidDiagram', () => ({
  default: ({ code }: { code: string }) => <div data-testid="mermaid-stub">{code}</div>,
}));

function fakeCommitOrchestrator(): CommitOrchestrator {
  return { triggerCommit: vi.fn().mockResolvedValue(undefined) };
}

describe('ChatScreen', () => {
  let db: ItIndexDB;
  let chatRepo: ChatRepository;
  let termsRepo: TermsRepository;
  let notesRepo: NotesRepository;

  beforeEach(() => {
    db = new ItIndexDB(`test-chatscreen-${crypto.randomUUID()}`);
    chatRepo = createChatRepository(db);
    termsRepo = createTermsRepository(db);
    notesRepo = createNotesRepository(db);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ used: 1, limit: 50 }) }));
  });

  afterEach(async () => {
    cleanup();
    clearToken();
    clearAiCredential();
    vi.unstubAllGlobals();
    await db.delete();
  });

  it('未ログイン時はAPIを呼ばずログイン案内を表示し、同期画面への誘導ボタンを持つ', async () => {
    const session = await chatRepo.createSession(null, 'ゼロトラスト');
    const aiClient: AiClient = { send: vi.fn() };
    const onGoToSync = vi.fn();

    render(
      <ChatScreen
        sessionId={session.id}
        chatRepo={chatRepo}
        termsRepo={termsRepo}
        notesRepo={notesRepo}
        aiClient={aiClient}
        commitOrchestrator={fakeCommitOrchestrator()}
        onBack={() => {}}
        onGoToSync={onGoToSync}
        onChangeSubject={() => {}}
      />,
    );

    expect(await screen.findByText('AIチャットにはログインが必要です。')).toBeTruthy();
    expect(aiClient.send).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('同期画面へ'));
    expect(onGoToSync).toHaveBeenCalled();
  });

  it('ログイン済みなら履歴を表示し、送信すると応答が追記される', async () => {
    setToken('tok-1');
    const session = await chatRepo.createSession(null, 'ゼロトラスト');
    const aiClient: AiClient = {
      send: vi.fn().mockResolvedValue({ text: '境界を信用しない考え方です。', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }),
    };

    render(
      <ChatScreen
        sessionId={session.id}
        chatRepo={chatRepo}
        termsRepo={termsRepo}
        notesRepo={notesRepo}
        aiClient={aiClient}
        commitOrchestrator={fakeCommitOrchestrator()}
        onBack={() => {}}
        onGoToSync={() => {}}
        onChangeSubject={() => {}}
      />,
    );

    const textarea = await screen.findByLabelText('メッセージ');
    fireEvent.change(textarea, { target: { value: 'ゼロトラストって何？' } });
    fireEvent.click(screen.getByText('送信'));

    await waitFor(() => expect(screen.getByText('境界を信用しない考え方です。')).toBeTruthy());
  });

  it('AIの返答に```mermaidブロックが含まれる場合はMermaidDiagramへ渡す', async () => {
    setToken('tok-1');
    const session = await chatRepo.createSession(null, 'ゼロトラスト');
    const aiClient: AiClient = {
      send: vi.fn().mockResolvedValue({
        text: '図で説明します。\n```mermaid\ngraph TD;A-->B;\n```\n以上です。',
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };

    render(
      <ChatScreen
        sessionId={session.id}
        chatRepo={chatRepo}
        termsRepo={termsRepo}
        notesRepo={notesRepo}
        aiClient={aiClient}
        commitOrchestrator={fakeCommitOrchestrator()}
        onBack={() => {}}
        onGoToSync={() => {}}
        onChangeSubject={() => {}}
      />,
    );

    const textarea = await screen.findByLabelText('メッセージ');
    fireEvent.change(textarea, { target: { value: '図で教えて' } });
    fireEvent.click(screen.getByText('送信'));

    await waitFor(() => expect(screen.getByTestId('mermaid-stub')).toBeTruthy());
    expect(screen.getByTestId('mermaid-stub').textContent).toBe('graph TD;A-->B;');
    expect(screen.getByText(/図で説明します。/)).toBeTruthy();
    expect(screen.getByText(/以上です。/)).toBeTruthy();
  });

  it('refusalでtextが空の場合は案内文を表示する', async () => {
    setToken('tok-1');
    const session = await chatRepo.createSession(null, 'なにか');
    const aiClient: AiClient = {
      send: vi.fn().mockResolvedValue({ text: '', stopReason: 'refusal', usage: { inputTokens: 1, outputTokens: 0 } }),
    };

    render(
      <ChatScreen
        sessionId={session.id}
        chatRepo={chatRepo}
        termsRepo={termsRepo}
        notesRepo={notesRepo}
        aiClient={aiClient}
        commitOrchestrator={fakeCommitOrchestrator()}
        onBack={() => {}}
        onGoToSync={() => {}}
        onChangeSubject={() => {}}
      />,
    );

    const textarea = await screen.findByLabelText('メッセージ');
    fireEvent.change(textarea, { target: { value: '危険な質問' } });
    fireEvent.click(screen.getByText('送信'));

    await waitFor(() => expect(screen.getByText('AIが応答を控えました。別の聞き方を試してください。')).toBeTruthy());
  });

  it('「話題を変える」で用語を選ぶとonChangeSubjectが選んだtermIdで呼ばれる', async () => {
    const term = buildTermRecord({ term: 'TCP/IP', readings: ['ティーシーピーアイピー'], summary: '通信規約', field: 'ネットワーク', origin: 'seed', now: 1 });
    await termsRepo.bulkPutFromSeed([term]);
    setToken('tok-1');
    const session = await chatRepo.createSession(null, 'なにか');
    const onChangeSubject = vi.fn();

    render(
      <ChatScreen
        sessionId={session.id}
        chatRepo={chatRepo}
        termsRepo={termsRepo}
        notesRepo={notesRepo}
        aiClient={{ send: vi.fn() }}
        commitOrchestrator={fakeCommitOrchestrator()}
        onBack={() => {}}
        onGoToSync={() => {}}
        onChangeSubject={onChangeSubject}
      />,
    );

    await screen.findByLabelText('メッセージ');
    fireEvent.click(screen.getByText('話題を変える'));

    const picker = await screen.findByText('話題にする用語を選ぶ');
    expect(picker).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('用語を入力'), { target: { value: 'TCP' } });
    const result = await screen.findByText('TCP/IP');
    fireEvent.click(result.closest('button')!);

    expect(onChangeSubject).toHaveBeenCalledWith(term.id);
    expect(screen.queryByText('話題にする用語を選ぶ')).toBeNull();
  });

  it('用語モードでは既存の初期説明を持つ用語名を見出しに表示する', async () => {
    const term = buildTermRecord({ term: 'TCP/IP', readings: ['ティーシーピーアイピー'], summary: '通信規約', field: 'ネットワーク', origin: 'seed', now: 1 });
    await termsRepo.bulkPutFromSeed([term]);
    setToken('tok-1');
    const session = await chatRepo.createSession(term.id);

    render(
      <ChatScreen
        sessionId={session.id}
        chatRepo={chatRepo}
        termsRepo={termsRepo}
        notesRepo={notesRepo}
        aiClient={{ send: vi.fn() }}
        commitOrchestrator={fakeCommitOrchestrator()}
        onBack={() => {}}
        onGoToSync={() => {}}
        onChangeSubject={() => {}}
      />,
    );

    expect(await screen.findByText('TCP/IPについて')).toBeTruthy();
  });

  it('「登録しない」を押すとdeclinedへ遷移しonBackが呼ばれる', async () => {
    setToken('tok-1');
    const session = await chatRepo.createSession(null, 'なにか');
    const onBack = vi.fn();

    render(
      <ChatScreen
        sessionId={session.id}
        chatRepo={chatRepo}
        termsRepo={termsRepo}
        notesRepo={notesRepo}
        aiClient={{ send: vi.fn() }}
        commitOrchestrator={fakeCommitOrchestrator()}
        onBack={onBack}
        onGoToSync={() => {}}
        onChangeSubject={() => {}}
      />,
    );

    await screen.findByLabelText('メッセージ');
    fireEvent.click(screen.getByText('登録しない'));

    await waitFor(() => expect(onBack).toHaveBeenCalled());
    const stored = await chatRepo.getSession(session.id);
    expect(stored?.status).toBe('declined');
  });

  it('戻るリンクは画面上部の1つだけで、下部に重複が無い(UIレビュー反映)', async () => {
    setToken('tok-1');
    const session = await chatRepo.createSession(null, 'なにか');

    render(
      <ChatScreen
        sessionId={session.id}
        chatRepo={chatRepo}
        termsRepo={termsRepo}
        notesRepo={notesRepo}
        aiClient={{ send: vi.fn() }}
        commitOrchestrator={fakeCommitOrchestrator()}
        onBack={() => {}}
        onGoToSync={() => {}}
        onChangeSubject={() => {}}
      />,
    );

    await screen.findByLabelText('メッセージ');
    expect(screen.getAllByText('← 戻る')).toHaveLength(1);
  });

  it('Enterで送信され、Shift+EnterもIME変換中のEnterも送信しない', async () => {
    setToken('tok-1');
    const session = await chatRepo.createSession(null, 'なにか');
    const aiClient: AiClient = {
      send: vi.fn().mockResolvedValue({ text: '回答です。', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }),
    };

    render(
      <ChatScreen
        sessionId={session.id}
        chatRepo={chatRepo}
        termsRepo={termsRepo}
        notesRepo={notesRepo}
        aiClient={aiClient}
        commitOrchestrator={fakeCommitOrchestrator()}
        onBack={() => {}}
        onGoToSync={() => {}}
        onChangeSubject={() => {}}
      />,
    );

    const textarea = await screen.findByLabelText('メッセージ');

    // IME変換確定のEnterは送信しない
    fireEvent.change(textarea, { target: { value: 'へんかんちゅう' } });
    fireEvent.keyDown(textarea, { key: 'Enter', nativeEvent: { isComposing: true } });
    expect(aiClient.send).not.toHaveBeenCalled();

    // Shift+Enterは改行のみで送信しない
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true, nativeEvent: { isComposing: false } });
    expect(aiClient.send).not.toHaveBeenCalled();

    // 通常のEnterは送信する
    fireEvent.change(textarea, { target: { value: 'しつもんです' } });
    fireEvent.keyDown(textarea, { key: 'Enter', nativeEvent: { isComposing: false } });

    await waitFor(() => expect(aiClient.send).toHaveBeenCalled());
  });

  it('initialQuestionが渡されるとセッション読み込み後に1回だけ自動送信する', async () => {
    setToken('tok-1');
    const session = await chatRepo.createSession(null, 'ゼロトラスト');
    const aiClient: AiClient = {
      send: vi.fn().mockResolvedValue({ text: '境界を信用しない考え方です。', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }),
    };

    const { rerender } = render(
      <ChatScreen
        sessionId={session.id}
        chatRepo={chatRepo}
        termsRepo={termsRepo}
        notesRepo={notesRepo}
        aiClient={aiClient}
        commitOrchestrator={fakeCommitOrchestrator()}
        onBack={() => {}}
        onGoToSync={() => {}}
        onChangeSubject={() => {}}
        initialQuestion="ゼロトラストって何？"
      />,
    );

    await waitFor(() => expect(screen.getByText('境界を信用しない考え方です。')).toBeTruthy());
    expect(aiClient.send).toHaveBeenCalledTimes(1);

    // 再レンダリングしても二重送信しない
    rerender(
      <ChatScreen
        sessionId={session.id}
        chatRepo={chatRepo}
        termsRepo={termsRepo}
        notesRepo={notesRepo}
        aiClient={aiClient}
        commitOrchestrator={fakeCommitOrchestrator()}
        onBack={() => {}}
        onGoToSync={() => {}}
        onChangeSubject={() => {}}
        initialQuestion="ゼロトラストって何？"
      />,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(aiClient.send).toHaveBeenCalledTimes(1);
  });

  it('license_requiredが返ったら設定タブへの誘導を表示する(要件定義書§4)', async () => {
    setToken('tok-1');
    const session = await chatRepo.createSession(null, 'なにか');
    const onGoToSettings = vi.fn();
    const aiClient: AiClient = {
      send: vi.fn().mockRejectedValue(
        new ApiRequestError(
          {
            code: 'license_required',
            message: '同期と共有AIの利用にはライセンスが必要です。設定画面から購入(モック)するか、自分のサーバーを設定してください。',
          },
          403,
        ),
      ),
    };

    render(
      <ChatScreen
        sessionId={session.id}
        chatRepo={chatRepo}
        termsRepo={termsRepo}
        notesRepo={notesRepo}
        aiClient={aiClient}
        commitOrchestrator={fakeCommitOrchestrator()}
        onBack={() => {}}
        onGoToSync={() => {}}
        onGoToSettings={onGoToSettings}
        onChangeSubject={() => {}}
      />,
    );

    const textarea = await screen.findByLabelText('メッセージ');
    fireEvent.change(textarea, { target: { value: 'しつもん' } });
    fireEvent.click(screen.getByText('送信'));

    await waitFor(() =>
      expect(
        screen.getByText('ライセンスが必要です。設定タブから購入(モック)するか、自分のサーバーを設定してください。'),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByText('設定タブへ'));
    expect(onGoToSettings).toHaveBeenCalled();
  });

  // 利用者持ち込みキー(BYOK)。docs/v2/architecture.md §5。
  describe('自分のAPIキー使用時', () => {
    function renderChat(overrides: { aiClient?: AiClient; onGoToSync?: () => void } = {}, sessionId?: string) {
      render(
        <ChatScreen
          sessionId={sessionId ?? ''}
          chatRepo={chatRepo}
          termsRepo={termsRepo}
          notesRepo={notesRepo}
          aiClient={overrides.aiClient ?? { send: vi.fn() }}
          commitOrchestrator={fakeCommitOrchestrator()}
          onBack={() => {}}
          onGoToSync={overrides.onGoToSync ?? (() => {})}
          onChangeSubject={() => {}}
        />,
      );
    }

    it('サーバー側キー利用時は残量を表示する', async () => {
      setToken('tok-1');
      const session = await chatRepo.createSession(null, 'なにか');
      renderChat({}, session.id);

      expect(await screen.findByText('本日の利用: 1/50')).toBeTruthy();
    });

    it('自分のキー設定時は残量を取得せず「回数上限なし」に切り替える', async () => {
      setToken('tok-1');
      saveVerifiedCredential({ key: 'sk-user-1234567890', provider: 'openai' });
      const session = await chatRepo.createSession(null, 'なにか');
      renderChat({}, session.id);

      expect(await screen.findByText('自分のAPIキーを使用中(OpenAI・回数上限なし)')).toBeTruthy();
      expect(screen.queryByText(/本日の利用:/)).toBeNull();
      // /api/ai/quota は利用者キー利用時に意味を持たないため呼ばない
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('user_api_key_invalidが返ったら日本語で案内し設定画面へ誘導する', async () => {
      setToken('tok-1');
      saveVerifiedCredential({ key: 'sk-bad-key', provider: 'openai' });
      const session = await chatRepo.createSession(null, 'なにか');
      const onGoToSync = vi.fn();
      const aiClient: AiClient = {
        send: vi.fn().mockRejectedValue(
          new ApiRequestError(
            {
              code: 'user_api_key_invalid',
              message: '設定したAPIキーが無効です。設定画面で確認してください',
            },
            400,
          ),
        ),
      };

      renderChat({ aiClient, onGoToSync }, session.id);

      const textarea = await screen.findByLabelText('メッセージ');
      fireEvent.change(textarea, { target: { value: 'しつもん' } });
      fireEvent.click(screen.getByText('送信'));

      await waitFor(() =>
        expect(screen.getByText('設定したAPIキーが無効です。設定画面で確認してください')).toBeTruthy(),
      );
      fireEvent.click(screen.getByText('設定画面へ'));
      expect(onGoToSync).toHaveBeenCalled();
    });

    it('通常のエラーでは設定画面への誘導を出さない', async () => {
      setToken('tok-1');
      const session = await chatRepo.createSession(null, 'なにか');
      const aiClient: AiClient = {
        send: vi.fn().mockRejectedValue(
          new ApiRequestError(
            { code: 'ai_limit_exceeded', message: '本日の利用回数の上限に達しました。明日また利用できます' },
            429,
          ),
        ),
      };

      renderChat({ aiClient }, session.id);

      const textarea = await screen.findByLabelText('メッセージ');
      fireEvent.change(textarea, { target: { value: 'しつもん' } });
      fireEvent.click(screen.getByText('送信'));

      await waitFor(() =>
        expect(screen.getByText('本日の利用回数の上限に達しました。明日また利用できます')).toBeTruthy(),
      );
      expect(screen.queryByText('設定画面へ')).toBeNull();
    });
  });
});
