import { describe, expect, it } from 'vitest';
import type { AiMessage } from './aiClient';
import { MAX_SENT_MESSAGES, trimChatHistory } from './trimHistory';

/** user/assistantが交互に並ぶ履歴を作る(先頭はuser) */
function alternating(count: number, contentLength = 10): AiMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `${i}`.padEnd(contentLength, 'あ'),
  }));
}

describe('trimChatHistory', () => {
  it('空の履歴はそのまま空を返す(新規セッション)', () => {
    expect(trimChatHistory([])).toEqual({ messages: [], omitted: 0 });
  });

  it('上限未満なら全件をそのまま返す', () => {
    const history = alternating(6);
    const result = trimChatHistory(history);
    expect(result.messages).toEqual(history);
    expect(result.omitted).toBe(0);
  });

  it('件数の上限を超えたら古い方を落とす', () => {
    const history = alternating(30);
    const result = trimChatHistory(history);
    expect(result.messages.length).toBeLessThanOrEqual(MAX_SENT_MESSAGES);
    expect(result.omitted).toBe(history.length - result.messages.length);
    // 残るのは必ず新しい方(末尾は元の末尾のまま)
    expect(result.messages[result.messages.length - 1]).toEqual(history[history.length - 1]);
  });

  it('文字数の上限でも切れる(1件が長い場合は件数上限より先に効く)', () => {
    const history: AiMessage[] = [
      { role: 'user', content: 'あ'.repeat(500) },
      { role: 'assistant', content: 'い'.repeat(500) },
      { role: 'user', content: 'う'.repeat(500) },
    ];
    const result = trimChatHistory(history, { maxMessages: 10, maxChars: 1200 });
    // 500*3=1500 > 1200 のため先頭が落ち、残り2件(1000文字)になる…が、
    // 先頭がassistantになるためさらに1件落ちてuser始まりに揃う
    expect(result.messages.map((m) => m.role)).toEqual(['user']);
    expect(result.omitted).toBe(2);
  });

  it('切った結果の先頭は必ずuserになる(サーバーの先頭ロール検証に合わせる)', () => {
    // 偶数件で切ると先頭がassistantになる並びを作る
    const history = alternating(21); // 先頭user、末尾user
    const result = trimChatHistory(history, { maxMessages: 4 });
    expect(result.messages[0].role).toBe('user');
    // assistant始まりを避けるため、上限4件より1件少なくなる
    expect(result.messages.length).toBe(3);
  });

  it('偶数の上限でも奇数の上限でも、先頭がassistantで返ることはない', () => {
    const history = alternating(30);
    for (let max = 1; max <= 12; max++) {
      const result = trimChatHistory(history, { maxMessages: max });
      if (result.messages.length > 0) {
        expect(result.messages[0].role).toBe('user');
      }
      expect(result.messages.length).toBeLessThanOrEqual(max);
    }
  });

  it('直近1件がassistantで上限を超える長さなら空を返す(呼び出し側のuserで形が整う)', () => {
    const history: AiMessage[] = [
      { role: 'user', content: 'あ'.repeat(100) },
      { role: 'assistant', content: 'い'.repeat(5000) },
    ];
    const result = trimChatHistory(history, { maxMessages: 10, maxChars: 1000 });
    // assistant1件だけを残すとサーバーに400で弾かれるため、残さない
    expect(result.messages).toEqual([]);
    expect(result.omitted).toBe(2);
  });

  it('1往復だけの履歴はそのまま返る', () => {
    const history = alternating(2);
    const result = trimChatHistory(history);
    expect(result.messages).toEqual(history);
    expect(result.omitted).toBe(0);
  });

  it('落とした件数がomittedと一致する(区切りの表示位置に使う)', () => {
    const history = alternating(30);
    const result = trimChatHistory(history);
    expect(history.slice(result.omitted)).toEqual(result.messages);
  });
});
