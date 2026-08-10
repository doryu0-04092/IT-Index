import type { AiClient, AiSendResult } from './aiClient';

/**
 * テスト専用フェイクAiClient(v1 ../../../src/ai/testSupport.ts参照)。実際のAPI呼び出しは
 * テストできないため、これを注入してオーケストレーション(メッセージ組み立て・DB書き込み・
 * エラー処理)だけを単体テストする。
 */
export function createScriptedAiClient(responses: string[]): AiClient {
  let index = 0;
  return {
    send() {
      const text = responses[Math.min(index, responses.length - 1)];
      index++;
      const result: AiSendResult = { text, stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } };
      return Promise.resolve(result);
    },
  };
}
