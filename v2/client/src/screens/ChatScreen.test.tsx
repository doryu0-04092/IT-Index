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
import { clearApiKey, setApiKey } from '../sync/apiKeyStore';
import { ApiRequestError } from '../sync/apiClient';
import ChatScreen from './ChatScreen';

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
    clearApiKey();
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
      />,
    );

    const textarea = await screen.findByLabelText('メッセージ');
    fireEvent.change(textarea, { target: { value: 'ゼロトラストって何？' } });
    fireEvent.click(screen.getByText('送信'));

    await waitFor(() => expect(screen.getByText('境界を信用しない考え方です。')).toBeTruthy());
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
      />,
    );

    const textarea = await screen.findByLabelText('メッセージ');
    fireEvent.change(textarea, { target: { value: '危険な質問' } });
    fireEvent.click(screen.getByText('送信'));

    await waitFor(() => expect(screen.getByText('AIが応答を控えました。別の聞き方を試してください。')).toBeTruthy());
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
      />,
    );

    await screen.findByLabelText('メッセージ');
    fireEvent.click(screen.getByText('登録しない'));

    await waitFor(() => expect(onBack).toHaveBeenCalled());
    const stored = await chatRepo.getSession(session.id);
    expect(stored?.status).toBe('declined');
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
      setApiKey('sk-user-1234567890');
      const session = await chatRepo.createSession(null, 'なにか');
      renderChat({}, session.id);

      expect(await screen.findByText('自分のAPIキーを使用中(回数上限なし)')).toBeTruthy();
      expect(screen.queryByText(/本日の利用:/)).toBeNull();
      // /api/ai/quota は利用者キー利用時に意味を持たないため呼ばない
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('user_api_key_invalidが返ったら日本語で案内し設定画面へ誘導する', async () => {
      setToken('tok-1');
      setApiKey('sk-bad-key');
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
