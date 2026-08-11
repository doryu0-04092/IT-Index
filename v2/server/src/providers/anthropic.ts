// architecture.md §5: Anthropic Messages APIへの転送。
import type { Env } from '../types';
import type { ChatMessage, AiResult, ProviderCallOptions } from '../ai';
import { detectModelUnknown, mapUpstreamError } from './upstreamError';

type AnthropicMessagesResponse = {
  content: Array<{ type: string; text?: string }>;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
};

// 2026年現在のAnthropic Messages API契約。temperature/top_p/top_k・thinking・
// 末尾assistantのprefillは送らない。content配列はtype==="text"のblockのみ連結する
// (thinking blockが先頭に来ることがあるため、content[0]を無条件に読まない)。
//
// options.userApiKeyが与えられた場合はそれで上流を呼び、サーバー側のANTHROPIC_API_KEYは
// 一切参照しない(docs/v2/architecture.md §5「2つのキー経路」)。利用者キーの寿命は
// このリクエスト分だけで、用途は上流のx-api-keyヘッダのみ。応答・エラーにも値は載らない。
export async function callAnthropic(
  env: Env,
  messages: ChatMessage[],
  system: string | undefined,
  options: ProviderCallOptions
): Promise<AiResult> {
  const usingUserKey = options.userApiKey !== undefined;
  // ANTHROPIC_API_KEYはEnv型上は任意(openai運用時は未設定でも起動できるようにするため)。
  // 使う瞬間(この関数が呼ばれた時)に無ければai_config_errorにする。
  // 利用者キー利用時はサーバー側キーの有無を問わない(未設定でも動く)。
  const apiKey = options.userApiKey ?? env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      error: { status: 500, code: 'ai_config_error', message: 'サーバーのAI設定に問題があります' },
    };
  }

  const requestBody: Record<string, unknown> = {
    model: options.model,
    max_tokens: options.maxTokens,
    messages,
  };
  if (system !== undefined) {
    requestBody.system = system;
  }

  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });
  } catch {
    // ネットワーク失敗(キーの値はエラーにも出さない)。
    return {
      ok: false,
      error: { status: 502, code: 'upstream_unreachable', message: 'AIサービスに接続できませんでした' },
    };
  }

  if (!res.ok) {
    const modelUnknown = await detectModelUnknown(res);
    return { ok: false, error: mapUpstreamError(res.status, { usingUserKey, modelUnknown }) };
  }

  const data = (await res.json()) as AnthropicMessagesResponse;
  const text = data.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');

  // stop_reason==="refusal"は成功扱いで返す(textが空になりうる)。
  return {
    ok: true,
    value: {
      text,
      stopReason: data.stop_reason,
      usage: { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens },
    },
  };
}
