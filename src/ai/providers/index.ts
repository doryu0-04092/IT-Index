import type { AiClient } from '../aiClient';
import type { AiCredential } from '../../keystore/apiKeyStore';
import { createClaudeClient, listClaudeModels } from './claude';
import { createGeminiClient, listGeminiModels } from './gemini';
import { createOpenAiClient, listOpenAiModels } from './openai';
import type { AiProvider } from './types';

export type { AiProvider, ProviderInfo } from './types';
export { getProviderInfo, PROVIDERS } from './types';

export function createProviderClient(provider: AiProvider, getApiKey: () => string | null, model: string): AiClient {
  switch (provider) {
    case 'anthropic':
      return createClaudeClient(getApiKey, model);
    case 'openai':
      return createOpenAiClient(getApiKey, model);
    case 'gemini':
      return createGeminiClient(getApiKey, model);
  }
}

/**
 * 利用可能なモデル一覧を取得する。APIキー入力画面の「接続確認」で使う
 * ——この呼び出し自体が疎通確認を兼ねる（キーが無効ならここで例外が飛ぶ）。
 */
export async function listModelsForProvider(provider: AiProvider, apiKey: string): Promise<string[]> {
  switch (provider) {
    case 'anthropic':
      return listClaudeModels(apiKey);
    case 'openai':
      return listOpenAiModels(apiKey);
    case 'gemini':
      return listGeminiModels(apiKey);
  }
}

/**
 * 呼び出し時点でのセッション資格情報（プロバイダ・モデル・キー）を毎回読み直して
 * 適切なプロバイダ実装へ振り分ける。利用者がAPIキー画面でプロバイダを切り替えても、
 * このクライアント自体を作り直す必要が無い（src/App.tsx で1回だけ生成すればよい）。
 */
export function createDynamicAiClient(getCredential: () => AiCredential | null): AiClient {
  return {
    async send(request) {
      const credential = getCredential();
      if (!credential) {
        throw new Error('APIキーが設定されていません');
      }
      const client = createProviderClient(credential.provider, () => credential.apiKey, credential.model);
      return client.send(request);
    },
  };
}
