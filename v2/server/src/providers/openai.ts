// architecture.md §5: OpenAI Chat Completions APIへの転送。
// 公式リファレンス(https://developers.openai.com/api/docs 配下、Chat Completions)で
// 確認した契約: 新しい世代のモデルはmax_tokensではなくmax_completion_tokensを使う
// (max_tokensはo-series等の新世代モデルと非互換のため廃止予定)。
// temperature/top_p等のサンプリングパラメータは送らない(新世代モデルは既定値以外を拒否しうる)。
import type { Env } from '../types';
import type { ChatMessage, AiResult, ProviderCallOptions } from '../ai';
import { detectModelUnknown, mapUpstreamError } from './upstreamError';

type OpenAiChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

type OpenAiChatCompletionResponse = {
  choices: Array<{ message: { content: string | null }; finish_reason: string }>;
  usage: { prompt_tokens: number; completion_tokens: number };
};

// stop_reasonの語彙をクライアント契約(Anthropic系のstopReason)に正規化する。
// stop→end_turn / length→max_tokens / content_filter→refusal / その他はそのまま文字列で返す
// (tool_calls等、このAPIでは使わないはずの値が来ても契約は破らない)。
function normalizeStopReason(finishReason: string): string {
  if (finishReason === 'stop') return 'end_turn';
  if (finishReason === 'length') return 'max_tokens';
  if (finishReason === 'content_filter') return 'refusal';
  return finishReason;
}

/**
 * options.userApiKeyが与えられた場合はそれで上流を呼び、サーバー側のOPENAI_API_KEYは一切参照しない
 * (docs/v2/architecture.md §5「2つのキー経路」)。利用者キーは保存もログ出力もしない:
 * この関数の外へ出るのはAuthorizationヘッダとしての上流リクエストだけで、
 * 成功応答にもエラー(mapUpstreamError)にも値は載らない。
 *
 * model/maxTokensは呼び出し元(ai.ts)で確定させたものを受け取る(既定値の決定はai.tsに集約)。
 */
export async function callOpenAi(
  env: Env,
  messages: ChatMessage[],
  system: string | undefined,
  options: ProviderCallOptions
): Promise<AiResult> {
  const usingUserKey = options.userApiKey !== undefined;
  // OPENAI_API_KEYはEnv型上は任意。使う瞬間(この関数が呼ばれた時)に無ければai_config_errorにする。
  // 利用者キー利用時はサーバー側キーの有無を問わない(未設定でも動く)。
  const apiKey = options.userApiKey ?? env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      error: { status: 500, code: 'ai_config_error', message: 'サーバーのAI設定に問題があります' },
    };
  }

  const openAiMessages: OpenAiChatMessage[] = [];
  if (system !== undefined) {
    openAiMessages.push({ role: 'system', content: system });
  }
  for (const message of messages) {
    openAiMessages.push({ role: message.role, content: message.content });
  }

  const requestBody: Record<string, unknown> = {
    model: options.model,
    messages: openAiMessages,
    max_completion_tokens: options.maxTokens,
  };

  let res: Response;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
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

  const data = (await res.json()) as OpenAiChatCompletionResponse;
  const choice = data.choices[0];

  return {
    ok: true,
    value: {
      text: choice?.message.content ?? '',
      stopReason: normalizeStopReason(choice?.finish_reason ?? ''),
      usage: {
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
      },
    },
  };
}
