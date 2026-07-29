import type { AiClient } from '../aiClient';
import { AiApiError } from '../errors';
import { fetchOrTranslateNetworkError } from '../networkError';

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TOKENS = 4096;

/**
 * architecture.md §4.1 のシーケンス図注記「thinking: disabled」は、
 * Messages API の thinking パラメータを付けない（＝既定で無効）ことを指す。
 * ブラウザから自前サーバー無しで直接叩くため anthropic-dangerous-direct-browser-access を付ける
 * （要件定義書 §3「ブラウザが直接、利用者自身の資格情報で外部APIを呼ぶ」）。
 * 実際に401応答まで含めて実機で疎通確認済み（docs/ai-client.md §6）。
 */
export function createClaudeClient(getApiKey: () => string | null, model: string): AiClient {
  return {
    async send({ system, messages }) {
      const apiKey = getApiKey();
      if (!apiKey) {
        throw new Error('APIキーが設定されていません');
      }

      const res = await fetchOrTranslateNetworkError(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model,
          max_tokens: MAX_TOKENS,
          system,
          messages,
        }),
      });

      if (!res.ok) {
        const rawBody = await res.text().catch(() => '');
        throw new AiApiError('anthropic', res.status, rawBody);
      }

      const data = (await res.json()) as ClaudeMessagesResponse;
      return extractText(data);
    },
  };
}

interface ClaudeMessagesResponse {
  content: Array<{ type: string; text?: string }>;
}

function extractText(response: ClaudeMessagesResponse): string {
  return response.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/**
 * 利用可能なモデルの一覧を取得する。APIキー入力画面で「モデル名を推測させない」
 * ためのモデル選択（プルダウン）に使う。同時に、この呼び出し自体がAPIキーの
 * 疎通確認を兼ねる（キーが無効なら401等でここで分かる）。
 */
export async function listClaudeModels(apiKey: string): Promise<string[]> {
  const res = await fetchOrTranslateNetworkError('https://api.anthropic.com/v1/models', {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    },
  });

  if (!res.ok) {
    const rawBody = await res.text().catch(() => '');
    throw new AiApiError('anthropic', res.status, rawBody);
  }

  const data = (await res.json()) as { data: Array<{ id: string }> };
  return data.data.map((m) => m.id);
}
