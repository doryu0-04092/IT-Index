import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ItIndexDB } from '../db';
import { createChatRepository } from '../repositories/chat';
import { sendChatTurn } from './chat';
import { createScriptedAiClient } from './testSupport';
import type { SubjectContext } from './subjectContext';

describe('sendChatTurn', () => {
  let db: ItIndexDB;

  beforeEach(() => {
    db = new ItIndexDB(`test-chat-ai-${crypto.randomUUID()}`);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('appends the user message as-is (no context prepended to message content), calls Claude with full history, and appends the reply', async () => {
    const chatRepo = createChatRepository(db);
    const session = await chatRepo.createSession('tcp');
    const claude = createScriptedAiClient(['TCP/IPとは...']);

    const reply = await sendChatTurn(session.id, 'TCP/IPって何？', { chatRepo, claude });

    expect(reply).toBe('TCP/IPとは...');
    const messages = await chatRepo.getMessages(session.id);
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'TCP/IPって何？'],
      ['assistant', 'TCP/IPとは...'],
    ]);
    expect(claude.calls[0].messages).toEqual([{ role: 'user', content: 'TCP/IPって何？' }]);
  });

  it('persists hidden:true on the user message when hideQuestion is passed (#44 対応)', async () => {
    const chatRepo = createChatRepository(db);
    const session = await chatRepo.createSession('tcp');
    const claude = createScriptedAiClient(['TCP/IPとは...']);

    await sendChatTurn(session.id, 'この用語の基本的な情報を教えてください。', { chatRepo, claude }, true);

    const messages = await chatRepo.getMessages(session.id);
    expect(messages[0]).toMatchObject({ role: 'user', hidden: true });
    expect(messages[1]).toMatchObject({ role: 'assistant', hidden: false });
  });

  it('sends the full conversation history on the next turn', async () => {
    const chatRepo = createChatRepository(db);
    const session = await chatRepo.createSession('tcp');
    const claude = createScriptedAiClient(['最初の回答', '2回目の回答']);

    await sendChatTurn(session.id, '1つ目の質問', { chatRepo, claude });
    await sendChatTurn(session.id, '2つ目の質問', { chatRepo, claude });

    expect(claude.calls[1].messages).toEqual([
      { role: 'user', content: '1つ目の質問' },
      { role: 'assistant', content: '最初の回答' },
      { role: 'user', content: '2つ目の質問' },
    ]);
  });

  it('uses the plain CHAT_SYSTEM_PROMPT when no subject is given', async () => {
    const chatRepo = createChatRepository(db);
    const session = await chatRepo.createSession(null);
    const claude = createScriptedAiClient(['自由な回答']);

    await sendChatTurn(session.id, '何か質問', { chatRepo, claude });

    const messages = await chatRepo.getMessages(session.id);
    expect(messages[0].content).toBe('何か質問'); // 文脈は混ぜない
    expect(claude.calls[0].system).not.toContain('現在の話題');
  });

  it('adds a "現在の話題" block to the system prompt in term mode (regression: これ／この disambiguation)', async () => {
    const chatRepo = createChatRepository(db);
    const session = await chatRepo.createSession('linux');
    const claude = createScriptedAiClient(['Linuxは...']);
    const subject: SubjectContext = {
      mode: 'term',
      termId: 'linux',
      label: 'Linux',
      field: 'ソフトウェア',
      readings: ['リナックス'],
      existingSummary: null,
      existingNoteBody: null,
    };

    await sendChatTurn(session.id, 'これはどういうもの？', { chatRepo, claude, subject });

    const messages = await chatRepo.getMessages(session.id);
    expect(messages[0].content).toBe('これはどういうもの？'); // 文脈はメッセージ本文に混ぜない
    expect(claude.calls[0].system).toContain('現在の話題');
    expect(claude.calls[0].system).toContain('Linux');
    expect(claude.calls[0].system).toContain('「これ」「この」などの指示語は');
    expect(claude.calls[0].system).toContain('「Linux」自身を指すものとして読んでください');
  });

  it('includes existing summary/note body as grounding when present', async () => {
    const chatRepo = createChatRepository(db);
    const session = await chatRepo.createSession('tcp/ip');
    const claude = createScriptedAiClient(['回答']);
    const subject: SubjectContext = {
      mode: 'term',
      termId: 'tcp/ip',
      label: 'TCP/IP',
      field: 'ネットワーク',
      readings: ['ティーシーピーアイピー'],
      existingSummary: '通信の取り決めを層に分けた規約の集まり。',
      existingNoteBody: '過去にAIへ聞いて育った説明。',
    };

    await sendChatTurn(session.id, 'もっと教えて', { chatRepo, claude, subject });

    expect(claude.calls[0].system).toContain('通信の取り決めを層に分けた規約の集まり。');
    expect(claude.calls[0].system).toContain('過去にAIへ聞いて育った説明。');
  });

  it('sends the subject block on every turn, not just the first', async () => {
    const chatRepo = createChatRepository(db);
    const session = await chatRepo.createSession('tcp/ip');
    const claude = createScriptedAiClient(['1回目の回答', '2回目の回答']);
    const subject: SubjectContext = {
      mode: 'term',
      termId: 'tcp/ip',
      label: 'TCP/IP',
      field: 'ネットワーク',
      readings: ['ティーシーピーアイピー'],
      existingSummary: null,
      existingNoteBody: null,
    };

    await sendChatTurn(session.id, '1つ目の質問', { chatRepo, claude, subject });
    await sendChatTurn(session.id, '2つ目の質問', { chatRepo, claude, subject });

    expect(claude.calls[0].system).toContain('現在の話題');
    expect(claude.calls[1].system).toContain('現在の話題'); // 2通目以降も毎回付ける
    const messages = await chatRepo.getMessages(session.id);
    expect(messages[2].content).toBe('2つ目の質問'); // メッセージ本文は変わらず
  });

  it('mentions the seed query as reference-only context in free mode', async () => {
    const chatRepo = createChatRepository(db);
    const session = await chatRepo.createSession(null);
    const claude = createScriptedAiClient(['回答']);
    const subject: SubjectContext = { mode: 'free', seedQuery: 'TCP/PI' };

    await sendChatTurn(session.id, '何ですか？', { chatRepo, claude, subject });

    expect(claude.calls[0].system).toContain('TCP/PI');
    expect(claude.calls[0].system).toContain('確定した用語ではありません');
  });
});
