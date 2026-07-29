import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ItIndexDB } from '../db';
import { createChatRepository } from '../repositories/chat';
import { sendChatTurn } from './chat';
import { createScriptedAiClient } from './testSupport';

describe('sendChatTurn', () => {
  let db: ItIndexDB;

  beforeEach(() => {
    db = new ItIndexDB(`test-chat-ai-${crypto.randomUUID()}`);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('appends the user message, calls Claude with full history, and appends the reply', async () => {
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

  it('prepends the term context to the first message when termLabel is given (from a term detail screen)', async () => {
    const chatRepo = createChatRepository(db);
    const session = await chatRepo.createSession('tcp/ip');
    const claude = createScriptedAiClient(['TCP/IPは...']);

    await sendChatTurn(session.id, 'よく分かりません', { chatRepo, claude, termLabel: 'TCP/IP' });

    const expectedContent =
      '「TCP/IP」についての質問です。以下の質問文中の「これ」「この」などの指示語は、断りが無い限り「TCP/IP」自身を指すものとして読んでください。\n\nよく分かりません';
    const messages = await chatRepo.getMessages(session.id);
    expect(messages[0].content).toBe(expectedContent);
    expect(claude.calls[0].messages).toEqual([{ role: 'user', content: expectedContent }]);
  });

  it('prepends context that disambiguates demonstrative pronouns like これ／この (regression: AI misread これ as an unrelated object)', async () => {
    const chatRepo = createChatRepository(db);
    const session = await chatRepo.createSession('linux');
    const claude = createScriptedAiClient(['Linuxは...']);

    await sendChatTurn(session.id, 'これはどういうもの？', { chatRepo, claude, termLabel: 'linux' });

    const messages = await chatRepo.getMessages(session.id);
    expect(messages[0].content).toContain('「これ」「この」などの指示語は');
    expect(messages[0].content).toContain('「linux」自身を指すものとして読んでください');
    expect(messages[0].content).toContain('これはどういうもの？');
  });

  it('does not prepend term context to the second message (history already carries it)', async () => {
    const chatRepo = createChatRepository(db);
    const session = await chatRepo.createSession('tcp/ip');
    const claude = createScriptedAiClient(['1回目の回答', '2回目の回答']);

    await sendChatTurn(session.id, '1つ目の質問', { chatRepo, claude, termLabel: 'TCP/IP' });
    await sendChatTurn(session.id, '2つ目の質問', { chatRepo, claude, termLabel: 'TCP/IP' });

    const messages = await chatRepo.getMessages(session.id);
    expect(messages[2].content).toBe('2つ目の質問'); // 文脈を付けない
  });

  it('does not prepend anything when termLabel is not given (free chat from the search screen)', async () => {
    const chatRepo = createChatRepository(db);
    const session = await chatRepo.createSession(null);
    const claude = createScriptedAiClient(['自由な回答']);

    await sendChatTurn(session.id, '何か質問', { chatRepo, claude });

    const messages = await chatRepo.getMessages(session.id);
    expect(messages[0].content).toBe('何か質問');
  });
});
