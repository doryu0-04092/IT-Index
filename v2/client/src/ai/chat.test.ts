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

    const reply = await sendChatTurn(session.id, 'TCP/IPって何？', {
      chatRepo,
      aiClient,
      subject: buildQuerySubject('TCP/IP'),
    });

    expect(reply).toBe('層に分けた通信規約の集まりです。');
    const messages = await chatRepo.getMessages(session.id);
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'TCP/IPって何？'],
      ['assistant', '層に分けた通信規約の集まりです。'],
    ]);
  });

  it('stopReason:refusalでtextが空の場合は案内文へ差し替える', async () => {
    const chatRepo = repo();
    const session = await chatRepo.createSession(null, 'なにか');
    const aiClient = fakeAiClient({ text: '', stopReason: 'refusal' });

    const reply = await sendChatTurn(session.id, '危険な質問', {
      chatRepo,
      aiClient,
      subject: buildQuerySubject('なにか'),
    });

    expect(reply).toBe(REFUSAL_MESSAGE);
    const messages = await chatRepo.getMessages(session.id);
    expect(messages[1].content).toBe(REFUSAL_MESSAGE);
  });

  it('ユーザーが実際に入力したテキストには文脈付与の文字列を混ぜない', async () => {
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
