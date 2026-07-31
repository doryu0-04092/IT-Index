import { describe, expect, it } from 'vitest';
import type { ChatMessageRecord, TermRecord } from '../types';
import { buildPendingChatFile } from './pendingChatFile';

function makeTerm(overrides: Partial<TermRecord> = {}): TermRecord {
  return {
    id: 'cors',
    term: 'CORS',
    readings: ['シーオーアールエス'],
    summary: '異なるオリジン間の通信をブラウザが制御する仕組み。',
    field: 'セキュリティ',
    tags: [],
    searchKey: 'cors',
    readingKeys: ['しーおーあーるえす'],
    origin: 'ai',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<ChatMessageRecord> = {}): ChatMessageRecord {
  return { id: '1', sessionId: 's1', role: 'user', content: 'CORSって何？', at: 0, ...overrides };
}

describe('buildPendingChatFile', () => {
  it('front matterに用語名とステータスを含める', () => {
    const file = buildPendingChatFile(makeTerm(), [makeMessage()]);
    expect(file).toContain('term: CORS');
    expect(file).toContain('status: 未確定');
  });

  it('ユーザー発言とAI発言をやり取りの順に含める', () => {
    const messages: ChatMessageRecord[] = [
      makeMessage({ id: '1', role: 'user', content: 'CORSって何？', at: 0 }),
      makeMessage({ id: '2', role: 'assistant', content: '異なるオリジン間の通信を制御する仕組みです。', at: 1 }),
    ];
    const file = buildPendingChatFile(makeTerm(), messages);
    const userIndex = file.indexOf('**利用者:** CORSって何？');
    const aiIndex = file.indexOf('**AI:** 異なるオリジン間の通信を制御する仕組みです。');
    expect(userIndex).toBeGreaterThan(-1);
    expect(aiIndex).toBeGreaterThan(userIndex);
  });

  it('用語名の改行は空白に置き換える', () => {
    const file = buildPendingChatFile(makeTerm({ term: 'A\nB' }), [makeMessage()]);
    expect(file).toContain('term: A B');
  });
});
