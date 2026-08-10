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
});
