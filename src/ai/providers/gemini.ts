import type { AiClient } from '../aiClient';
import { AiApiError } from '../errors';
import { fetchOrTranslateNetworkError } from '../networkError';

/**
 * Google Gemini（Generative Language API）。
 * ⚠️ 有効なGemini APIキーで実疎通確認はできていない（docs/ai-client.md §6）。
 * ドキュメント上のリクエスト・レスポンス形式に基づいて実装したのみ。
 * - system プロンプトは systemInstruction フィールドで別送りする（Anthropicと同じ形）
 * - role名が異なる: assistant ではなく 'model' を使う
 * - APIキーはヘッダーではなくクエリパラメータで渡す
 */
export function createGeminiClient(getApiKey: () => string | null, model: string): AiClient {
  return {
    async send({ system, messages }) {
      const apiKey = getApiKey();
      if (!apiKey) {
        throw new Error('APIキーが設定されていません');
      }

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

      const body = {
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: messages.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
      };

      const res = await fetchOrTranslateNetworkError(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const rawBody = await res.text().catch(() => '');
        throw new AiApiError('gemini', res.status, rawBody);
      }

      const data = (await res.json()) as GeminiGenerateContentResponse;
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      return parts.map((p) => p.text ?? '').join('');
    },
  };
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

/**
 * 利用可能なモデルの一覧を取得する（APIキーの疎通確認も兼ねる）。
 * `supportedGenerationMethods` に `generateContent` を含むものだけに絞る
 * （embedding専用モデル等を除外するため。Google公式ドキュメントで明記されているフィールド）。
 * 一覧のモデル名は `models/gemini-...` の形なので、`models/` プレフィックスを剥がして返す。
 */
export async function listGeminiModels(apiKey: string): Promise<string[]> {
  const res = await fetchOrTranslateNetworkError(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
  );

  if (!res.ok) {
    const rawBody = await res.text().catch(() => '');
    throw new AiApiError('gemini', res.status, rawBody);
  }

  const data = (await res.json()) as {
    models?: Array<{ name: string; supportedGenerationMethods?: string[] }>;
  };
  return (data.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''));
}
