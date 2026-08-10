// architecture.md §5: OpenAI Chat Completions APIへの転送。
// 公式リファレンス(https://developers.openai.com/api/docs 配下、Chat Completions)で
// 確認した契約: 新しい世代のモデルはmax_tokensではなくmax_completion_tokensを使う
// (max_tokensはo-series等の新世代モデルと非互換のため廃止予定)。
// temperature/top_p等のサンプリングパラメータは送らない(新世代モデルは既定値以外を拒否しうる)。
import type { Env } from '../types';
import type { ChatMessage, AiResult, AiFailure } from '../ai';

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

export async function callOpenAi(
  env: Env,
  messages: ChatMessage[],
  system: string | undefined
): Promise<AiResult> {
  // OPENAI_API_KEYはEnv型上は任意。使う瞬間(この関数が呼ばれた時)に無ければai_config_errorにする。
  if (!env.OPENAI_API_KEY) {
    return {
      ok: false,
      error: { status: 500, code: 'ai_config_error', message: 'サーバーのAI設定に問題があります' },
    };
  }

  const model = env.AI_MODEL ?? 'gpt-5.6-luna';
  const maxTokens = Number(env.AI_MAX_TOKENS ?? '4096');

  const openAiMessages: OpenAiChatMessage[] = [];
  if (system !== undefined) {
    openAiMessages.push({ role: 'system', content: system });
  }
  for (const message of messages) {
    openAiMessages.push({ role: message.role, content: message.content });
  }

  const requestBody: Record<string, unknown> = {
    model,
    messages: openAiMessages,
    max_completion_tokens: maxTokens,
  };

  let res: Response;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
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

function mapUpstreamError(status: number): AiFailure {
  if (status === 401 || status === 403) {
    // キーの値はログにも出さない。ステータス以外の詳細も返さない。
    return { status: 500, code: 'ai_config_error', message: 'サーバーのAI設定に問題があります' };
  }
  if (status === 429) {
    // OpenAIはクレジット不足(insufficient_quota)もこのステータスで返すため、
    // レート制限と利用枠超過の両方を汲んだ文言にする。
    return {
      status: 429,
      code: 'ai_upstream_rate_limited',
      message: 'AIが混み合っているか、利用枠を超えています。しばらくして再試行してください',
    };
  }
  if (status >= 400 && status < 500) {
    return { status: 500, code: 'ai_request_invalid', message: 'AIリクエストの組み立てに失敗しました' };
  }
  return { status: 502, code: 'ai_upstream_error', message: 'AIサービスでエラーが発生しました' };
}
