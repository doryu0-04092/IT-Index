// architecture.md §5: Anthropic Messages APIへの転送。
import type { Env } from '../types';
import type { ChatMessage, AiResult, AiFailure } from '../ai';

type AnthropicMessagesResponse = {
  content: Array<{ type: string; text?: string }>;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
};

// 2026年現在のAnthropic Messages API契約。temperature/top_p/top_k・thinking・
// 末尾assistantのprefillは送らない。content配列はtype==="text"のblockのみ連結する
// (thinking blockが先頭に来ることがあるため、content[0]を無条件に読まない)。
export async function callAnthropic(
  env: Env,
  messages: ChatMessage[],
  system: string | undefined
): Promise<AiResult> {
  // ANTHROPIC_API_KEYはEnv型上は任意(openai運用時は未設定でも起動できるようにするため)。
  // 使う瞬間(この関数が呼ばれた時)に無ければai_config_errorにする。
  if (!env.ANTHROPIC_API_KEY) {
    return {
      ok: false,
      error: { status: 500, code: 'ai_config_error', message: 'サーバーのAI設定に問題があります' },
    };
  }

  const model = env.AI_MODEL ?? 'claude-sonnet-5';
  const maxTokens = Number(env.AI_MAX_TOKENS ?? '4096');

  const requestBody: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
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
        'x-api-key': env.ANTHROPIC_API_KEY,
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
    return { ok: false, error: mapUpstreamError(res.status) };
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

function mapUpstreamError(status: number): AiFailure {
  if (status === 401 || status === 403) {
    // キーの値はログにも出さない。ステータス以外の詳細も返さない。
    return { status: 500, code: 'ai_config_error', message: 'サーバーのAI設定に問題があります' };
  }
  if (status === 429) {
    return {
      status: 429,
      code: 'ai_upstream_rate_limited',
      message: 'AIが混み合っています。しばらくして再試行してください',
    };
  }
  if (status === 529) {
    return { status: 503, code: 'ai_overloaded', message: 'AIが過負荷です' };
  }
  if (status >= 400 && status < 500) {
    return { status: 500, code: 'ai_request_invalid', message: 'AIリクエストの組み立てに失敗しました' };
  }
  return { status: 502, code: 'ai_upstream_error', message: 'AIサービスでエラーが発生しました' };
}
