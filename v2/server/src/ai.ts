// architecture.md §5: AIプロキシ。サーバー側で保持するAnthropic APIキーで
// Anthropic Messages APIへ転送する。会話内容はここでもD1にもログにも出さない。
import type { Env } from './types';

export type ChatMessage = { role: 'user' | 'assistant'; content: string };

const VALID_ROLES = new Set<string>(['user', 'assistant']);
const MIN_MESSAGES = 1;
const MAX_MESSAGES = 40;
const MAX_TOTAL_CONTENT_CHARS = 200_000;
const MAX_SYSTEM_CHARS = 10_000;

export type ChatRequestValidation =
  | { ok: true; messages: ChatMessage[]; system?: string }
  | { ok: false; error: string };

// 検証ルールはすべてこの関数に閉じる。違反はすべて400・日本語messageで返す想定。
export function validateChatRequest(body: unknown): ChatRequestValidation {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'リクエストボディが不正です' };
  }
  const { messages, system } = body as { messages?: unknown; system?: unknown };

  if (!Array.isArray(messages) || messages.length < MIN_MESSAGES || messages.length > MAX_MESSAGES) {
    return { ok: false, error: `messagesは1〜${MAX_MESSAGES}件の配列で指定してください` };
  }

  const parsed: ChatMessage[] = [];
  let totalChars = 0;
  for (let index = 0; index < messages.length; index++) {
    const raw = messages[index];
    if (typeof raw !== 'object' || raw === null) {
      return { ok: false, error: `messages[${index}]が不正です` };
    }
    const { role, content } = raw as { role?: unknown; content?: unknown };
    if (typeof role !== 'string' || !VALID_ROLES.has(role)) {
      return { ok: false, error: `messages[${index}].roleはuserまたはassistantで指定してください` };
    }
    if (typeof content !== 'string' || content.length === 0) {
      return { ok: false, error: `messages[${index}].contentは非空文字列で指定してください` };
    }
    totalChars += content.length;
    parsed.push({ role: role as 'user' | 'assistant', content });
  }

  if (parsed[0].role !== 'user') {
    return { ok: false, error: '先頭のmessageはuserである必要があります' };
  }

  if (totalChars > MAX_TOTAL_CONTENT_CHARS) {
    return { ok: false, error: `messagesの合計文字数は${MAX_TOTAL_CONTENT_CHARS}文字以下にしてください` };
  }

  let systemText: string | undefined;
  if (system !== undefined) {
    if (typeof system !== 'string') {
      return { ok: false, error: 'systemは文字列で指定してください' };
    }
    if (system.length > MAX_SYSTEM_CHARS) {
      return { ok: false, error: `systemは${MAX_SYSTEM_CHARS}文字以下にしてください` };
    }
    systemText = system;
  }

  return { ok: true, messages: parsed, system: systemText };
}

export type AnthropicSuccess = {
  text: string;
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number };
};

export type AnthropicFailure = { status: number; code: string; message: string };

export type AnthropicResult =
  | { ok: true; value: AnthropicSuccess }
  | { ok: false; error: AnthropicFailure };

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
): Promise<AnthropicResult> {
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

function mapUpstreamError(status: number): AnthropicFailure {
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
