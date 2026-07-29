import type { AiClient } from '../aiClient';
import { AiApiError } from '../errors';
import { fetchOrTranslateNetworkError } from '../networkError';

const API_URL = 'https://api.openai.com/v1/chat/completions';

/**
 * OpenAI の Chat Completions API。
 * ⚠️ 有効なOpenAI APIキーで実疎通確認はできていない（docs/ai-client.md §6）。
 * ドキュメント上のリクエスト・レスポンス形式に基づいて実装したのみ。
 * OpenAIはAnthropicのような system プロンプト専用フィールドを持たず、
 * role:'system' の1メッセージとして messages 配列の先頭に含める。
 */
export function createOpenAiClient(getApiKey: () => string | null, model: string): AiClient {
  return {
    async send({ system, messages }) {
      const apiKey = getApiKey();
      if (!apiKey) {
        throw new Error('APIキーが設定されていません');
      }

      const body = {
        model,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          ...messages.map((m) => ({ role: m.role, content: m.content })),
        ],
      };

      const res = await fetchOrTranslateNetworkError(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const rawBody = await res.text().catch(() => '');
        throw new AiApiError('openai', res.status, rawBody);
      }

      const data = (await res.json()) as OpenAiChatResponse;
      return data.choices[0]?.message.content ?? '';
    },
  };
}

interface OpenAiChatResponse {
  choices: Array<{ message: { role: string; content: string } }>;
}

/**
 * 利用可能なモデルの一覧を取得する（APIキーの疎通確認も兼ねる）。
 * OpenAIの一覧にはWhisper・DALL-E・埋め込み等チャット非対応のモデルも混在するため、
 * チャット系と思われるモデルIDだけに絞る簡易フィルタをかけている（完全ではない）。
 */
export async function listOpenAiModels(apiKey: string): Promise<string[]> {
  const res = await fetchOrTranslateNetworkError('https://api.openai.com/v1/models', {
    headers: { authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    const rawBody = await res.text().catch(() => '');
    throw new AiApiError('openai', res.status, rawBody);
  }

  const data = (await res.json()) as { data: Array<{ id: string }> };
  return data.data
    .map((m) => m.id)
    .filter((id) => /^(gpt-|o1|o3|o4|chatgpt)/.test(id))
    .filter((id) => !/(whisper|embedding|tts|dall-e|moderation|audio|realtime|transcribe|instruct)/.test(id))
    .sort();
}
