export type AiProvider = 'anthropic' | 'openai' | 'gemini';

export interface ProviderInfo {
  id: AiProvider;
  label: string;
  /** 未入力時に使う既定モデル名 */
  defaultModel: string;
  apiKeyPlaceholder: string;
}

/**
 * Claude（anthropic）以外の既定モデル名は、実際に疎通確認できていない
 * （手元に有効なOpenAI/Gemini APIキーが無いため。docs/ai-client.md §6参照）。
 * 古くなっている可能性があるので、利用者が自分の分かっているモデル名に
 * 上書きできるようにしてある（ApiKeyPromptのモデル欄）。
 */
export const PROVIDERS: readonly ProviderInfo[] = [
  { id: 'anthropic', label: 'Anthropic Claude', defaultModel: 'claude-sonnet-5', apiKeyPlaceholder: 'sk-ant-...' },
  { id: 'openai', label: 'OpenAI', defaultModel: 'gpt-4o', apiKeyPlaceholder: 'sk-...' },
  { id: 'gemini', label: 'Google Gemini', defaultModel: 'gemini-2.0-flash', apiKeyPlaceholder: 'AIza...' },
];

export function getProviderInfo(id: AiProvider): ProviderInfo {
  const info = PROVIDERS.find((p) => p.id === id);
  if (!info) throw new Error(`未知のプロバイダです: ${id}`);
  return info;
}
