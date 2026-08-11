// architecture.md §5: AIプロキシ。既定ではサーバー側で保持するAIプロバイダのAPIキーで
// 上流(Anthropic Messages API または OpenAI Chat Completions API)へ転送する。
// リクエストにapiKey(利用者持ち込みキー=BYOK)が付いている場合はそのキーで上流を呼び、
// サーバー側キーは使わず回数上限も適用しない(費用が本人負担のため。index.ts参照)。
// 会話内容も利用者キーもここでもD1にもログにも出さない(転送のみで、保存しない)。
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
// 利用者持ち込みキー(BYOK)の長さ上限。プロバイダのキー形式に依存しない安全側の値。
const MAX_API_KEY_CHARS = 200;
// キーはAuthorizationヘッダ(`Bearer <key>`)へ入るため、空白・制御文字・改行を含む値は
// ヘッダ注入の余地になる。印字可能ASCII(空白を除く)だけを許す。
const API_KEY_PATTERN = /^[\x21-\x7e]+$/;

export type ChatRequestValidation =
  | { ok: true; messages: ChatMessage[]; system?: string; userApiKey?: string }
  | { ok: false; error: string };

// 検証ルールはすべてこの関数に閉じる。違反はすべて400・日本語messageで返す想定。
export function validateChatRequest(body: unknown): ChatRequestValidation {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'リクエストボディが不正です' };
  }
  const { messages, system, apiKey } = body as {
    messages?: unknown;
    system?: unknown;
    apiKey?: unknown;
  };

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

  // 利用者持ち込みキー(任意)。空文字は「未指定」と同じ扱いにする(設定画面で消した直後の
  // 空文字がそのまま送られても、サーバー側キー+回数上限の通常経路に落ちるようにする)。
  // エラー文にキーの値そのものは一切載せない(長さも載せない)。
  let userApiKey: string | undefined;
  if (apiKey !== undefined && apiKey !== null) {
    if (typeof apiKey !== 'string') {
      return { ok: false, error: 'apiKeyは文字列で指定してください' };
    }
    const trimmed = apiKey.trim();
    if (trimmed.length > 0) {
      if (trimmed.length > MAX_API_KEY_CHARS) {
        return { ok: false, error: `apiKeyは${MAX_API_KEY_CHARS}文字以下にしてください` };
      }
      if (!API_KEY_PATTERN.test(trimmed)) {
        return { ok: false, error: 'apiKeyに使用できない文字が含まれています' };
      }
      userApiKey = trimmed;
    }
  }

  return { ok: true, messages: parsed, system: systemText, userApiKey };
}

export type AiSuccess = {
  text: string;
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number };
};

export type AiFailure = { status: number; code: string; message: string };

export type AiResult = { ok: true; value: AiSuccess } | { ok: false; error: AiFailure };

// AI_PROVIDER未設定時はコード既定で'anthropic'(後方互換)。
export function resolveProvider(env: Env): 'anthropic' | 'openai' {
  return env.AI_PROVIDER ?? 'anthropic';
}

// 呼び先の分岐だけをここで持つ。
// userApiKeyが与えられた場合はそのキーで上流を呼び、サーバー側キーは使わない。
// BYOKはOpenAI経路のみ(docs/v2/architecture.md §5)。Anthropic経路へ利用者キーが
// 渡ってくる経路は index.ts が事前に400で塞ぐため、ここには到達しない。
export async function callAi(
  env: Env,
  messages: ChatMessage[],
  system: string | undefined,
  userApiKey?: string
): Promise<AiResult> {
  if (resolveProvider(env) === 'openai') {
    return callOpenAi(env, messages, system, userApiKey);
  }
  return callAnthropic(env, messages, system);
}
