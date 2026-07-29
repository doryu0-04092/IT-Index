import type { AiClient, AiRequest } from './aiClient';

/**
 * テスト専用のフェイク AiClient。呼び出し順にキューから応答を返す。
 * プロバイダに依存しない（AiClientインターフェースだけを満たす）。
 * 実運用コードには含めない（テストファイルからのみ import する想定）。
 */
export function createScriptedAiClient(responses: string[]): AiClient & { calls: AiRequest[] } {
  const queue = [...responses];
  const calls: AiRequest[] = [];

  return {
    calls,
    async send(request) {
      calls.push(request);
      const next = queue.shift();
      if (next === undefined) {
        throw new Error('スクリプトされた応答が尽きました');
      }
      return next;
    },
  };
}
