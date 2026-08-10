// architecture.md §5: AIプロキシ。サーバー側で保持するAIプロバイダのAPIキーで
// 上流(Anthropic Messages API または OpenAI Chat Completions API)へ転送する。
// 会話内容はここでもD1にもログにも出さない。
// クライアントとの応答契約({"text","stopReason","usage":{inputTokens,outputTokens}})は
// プロバイダに関わらず共通。検証(validateChatRequest)・上限判定・エンドポイントも共通のまま、
// 実際の呼び先だけAI_PROVIDERで分岐する(providers/anthropic.ts・providers/openai.ts)。
import type { Env } from './types';
import { callAnthropic } from './providers/anthropic';
import { callOpenAi } from './providers/openai';

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

export type AiSuccess = {
  text: string;
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number };
};

export type AiFailure = { status: number; code: string; message: string };

export type AiResult = { ok: true; value: AiSuccess } | { ok: false; error: AiFailure };

// 呼び先の分岐だけをここで持つ。AI_PROVIDER未設定時はコード既定で'anthropic'(後方互換)。
export async function callAi(
  env: Env,
  messages: ChatMessage[],
  system: string | undefined
): Promise<AiResult> {
  const provider = env.AI_PROVIDER ?? 'anthropic';
  if (provider === 'openai') {
    return callOpenAi(env, messages, system);
  }
  return callAnthropic(env, messages, system);
}
