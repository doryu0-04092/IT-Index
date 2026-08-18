import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ItIndexDB } from '../db';
import { createChatRepository, type ChatRepository } from '../repositories/chat';
import type { AiClient } from './aiClient';
import { REFUSAL_MESSAGE, sendChatTurn } from './chat';
import { buildQuerySubject } from './subjectContext';

function fakeAiClient(result: { text: string; stopReason: string }): AiClient {
  return {
    send: vi.fn().mockResolvedValue({ text: result.text, stopReason: result.stopReason, usage: { inputTokens: 0, outputTokens: 0 } }),
  };
}

function failingAiClient(): AiClient {
  return { send: vi.fn().mockRejectedValue(new Error('network error')) };
}

describe('sendChatTurn', () => {
  const dbs: ItIndexDB[] = [];
  afterEach(async () => {
    for (const db of dbs) await db.delete();
    dbs.length = 0;
  });

  function repo(): ChatRepository {
    const db = new ItIndexDB(`test-chat-${crypto.randomUUID()}`);
    dbs.push(db);
    return createChatRepository(db);
  }

  it('ユーザー発言とAI応答をこの順で履歴へ追記する', async () => {
    const chatRepo = repo();
    const session = await chatRepo.createSession(null, 'TCP/IP');
    const aiClient = fakeAiClient({ text: '層に分けた通信規約の集まりです。', stopReason: 'end_turn' });

    const result = await sendChatTurn(session.id, 'TCP/IPって何？', {
      chatRepo,
      aiClient,
      subject: buildQuerySubject('TCP/IP'),
    });

    expect(result.reply).toBe('層に分けた通信規約の集まりです。');
    expect(result.sessionId).toBe(session.id);
    const messages = await chatRepo.getMessages(session.id);
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'TCP/IPって何？'],
      ['assistant', '層に分けた通信規約の集まりです。'],
    ]);
  });

  it('sessionId:null(下書き)ではAI応答の受信成功後にcreateSessionが呼ばれ、そのセッションへ保存する(#132)', async () => {
    const chatRepo = repo();
    const aiClient = fakeAiClient({ text: 'こたえ', stopReason: 'end_turn' });
    const createSession = vi.fn(() => chatRepo.createSession(null, 'ゼロトラスト'));

    const result = await sendChatTurn(null, 'ゼロトラストって何？', {
      chatRepo,
      aiClient,
      subject: buildQuerySubject('ゼロトラスト'),
      createSession,
    });

    expect(createSession).toHaveBeenCalledTimes(1);
    const messages = await chatRepo.getMessages(result.sessionId);
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'ゼロトラストって何？'],
      ['assistant', 'こたえ'],
    ]);
  });

  it('AI呼び出しが失敗した場合、下書きではセッションを作らない(#132)', async () => {
    const chatRepo = repo();
    const createSession = vi.fn(() => chatRepo.createSession(null, 'ゼロトラスト'));

    await expect(
      sendChatTurn(null, 'ゼロトラストって何？', {
        chatRepo,
        aiClient: failingAiClient(),
        subject: buildQuerySubject('ゼロトラスト'),
        createSession,
      }),
    ).rejects.toThrow('network error');

    expect(createSession).not.toHaveBeenCalled();
    expect(await chatRepo.getOpenSessions()).toHaveLength(0);
  });

  it('AI呼び出しが失敗した場合、既存セッションには質問を追記しない(#132)', async () => {
    const chatRepo = repo();
    const session = await chatRepo.createSession(null, 'TCP/IP');
    await chatRepo.appendMessage(session.id, 'user', '1ターン目の質問');
    await chatRepo.appendMessage(session.id, 'assistant', '1ターン目の返答');

    await expect(
      sendChatTurn(session.id, '2ターン目の質問', {
        chatRepo,
        aiClient: failingAiClient(),
        subject: buildQuerySubject('TCP/IP'),
      }),
    ).rejects.toThrow('network error');

    // 過去のやり取りはそのまま。失敗したターンの質問は保存されない
    const messages = await chatRepo.getMessages(session.id);
    expect(messages.map((m) => m.content)).toEqual(['1ターン目の質問', '1ターン目の返答']);
  });

  it('stopReason:refusalでtextが空の場合は案内文へ差し替えて保存する(返答が返ってきた扱い)', async () => {
    const chatRepo = repo();
    const session = await chatRepo.createSession(null, 'なにか');
    const aiClient = fakeAiClient({ text: '', stopReason: 'refusal' });

    const result = await sendChatTurn(session.id, '危険な質問', {
      chatRepo,
      aiClient,
      subject: buildQuerySubject('なにか'),
    });

    expect(result.reply).toBe(REFUSAL_MESSAGE);
    const messages = await chatRepo.getMessages(session.id);
    expect(messages[1].content).toBe(REFUSAL_MESSAGE);
  });

  it('ユーザーが実際に入力したテキストには文脈付与の文字列を混ぜず、今回の質問を履歴末尾に載せてAIへ渡す', async () => {
    const chatRepo = repo();
    const session = await chatRepo.createSession(null, 'TCP/IP');
    const aiClient = fakeAiClient({ text: 'こたえ', stopReason: 'end_turn' });

    await sendChatTurn(session.id, 'これはどういうもの？', {
      chatRepo,
      aiClient,
      subject: buildQuerySubject('TCP/IP'),
    });

    const messages = await chatRepo.getMessages(session.id);
    expect(messages[0].content).toBe('これはどういうもの？');

    const sentRequest = (aiClient.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sentRequest.system).toContain('TCP/IP');
    expect(sentRequest.messages[0].content).toBe('これはどういうもの？');
  });
});
