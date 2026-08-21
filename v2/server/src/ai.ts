// architecture.md §5: AIプロキシ。既定ではサーバー側で保持するAIプロバイダのAPIキーで
// 上流(Anthropic Messages API または OpenAI Chat Completions API)へ転送する。
// リクエストにapiKey(利用者持ち込みキー=BYOK)が付いている場合はそのキーで上流を呼び、
// サーバー側キーは使わず回数上限も適用しない(費用が本人負担のため。index.ts参照)。
// 利用者キーの場合はapiProvider(openai/anthropic)を利用者が選べる。サーバー運用の
// AI_PROVIDERとは独立で、サーバーがopenai運用でも利用者はanthropicのキーを持ち込める。
// 会話内容も利用者キーもここでもD1にもログにも出さない(転送のみで、保存しない)。
// クライアントとの応答契約({"text","stopReason","usage":{inputTokens,outputTokens}})は
// プロバイダに関わらず共通。検証(validateChatRequest)・上限判定・エンドポイントも共通のまま、
// 実際の呼び先だけで分岐する(providers/anthropic.ts・providers/openai.ts)。
import type { Env } from './types';
import { callAnthropic } from './providers/anthropic';
import { callOpenAi } from './providers/openai';

export type ChatMessage = { role: 'user' | 'assistant'; content: string };

/** 上流プロバイダの識別子。サーバー運用(AI_PROVIDER)と利用者キーの選択で同じ語彙を使う */
export type ApiProvider = 'anthropic' | 'openai';

const VALID_ROLES = new Set<string>(['user', 'assistant']);
const VALID_PROVIDERS = new Set<string>(['anthropic', 'openai']);
const MIN_MESSAGES = 1;
/**
 * 件数の外枠(#181で 40 → 120 に引き上げ)。
 *
 * **実効の上限はクライアント側へ移した**(`v2/client/src/ai/trimHistory.ts`。チャットは
 * 直近12件だけを送る)。ここはその外側にある境界の防御で、想定外に大きなリクエストを
 * 弾くためだけに残す。
 *
 * 引き上げた理由: 「確定」(分配統合)は**会話全体を語ごとに切り分ける処理**のため全量を送る
 * 必要があり(`v2/client/src/ai/prompts.ts` buildDistributionMessages)、40のままだと
 * **21往復を超えたセッションは確定が必ず400で失敗していた**。利用者からは「取り込みが
 * 何度やっても失敗する」に見える。制限の緩和だが、実効上限がクライアント側にある以上、
 * ここは確定が通る外枠であるべき。
 *
 * 送信量そのものの歯止めは MAX_TOTAL_CONTENT_CHARS(据え置き)が引き続き担う。
 */
const MAX_MESSAGES = 120;
const MAX_TOTAL_CONTENT_CHARS = 200_000;
const MAX_SYSTEM_CHARS = 10_000;
// 利用者持ち込みキー(BYOK)の長さ上限。プロバイダのキー形式に依存しない安全側の値。
const MAX_API_KEY_CHARS = 200;
// キーはAuthorizationヘッダ(`Bearer <key>`)またはx-api-keyヘッダへ入るため、空白・制御文字・
// 改行を含む値はヘッダ注入の余地になる。印字可能ASCII(空白を除く)だけを許す。
const API_KEY_PATTERN = /^[\x21-\x7e]+$/;
// モデル名はヘッダではなくJSONボディへ入るが、上流のパス・識別子として使われる値なので
// 英数と区切り記号だけに絞る(想定外の値をそのまま上流へ渡さない)。
const MAX_MODEL_CHARS = 100;
const MODEL_PATTERN = /^[A-Za-z0-9._:/-]+$/;

/** プロバイダごとのモデル既定値(AI_MODELが当該プロバイダ向けでない場合に使う) */
const DEFAULT_MODEL: Record<ApiProvider, string> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5.6-luna',
};

export type ChatRequestValidation =
  | {
      ok: true;
      messages: ChatMessage[];
      system?: string;
      userApiKey?: string;
      /** userApiKeyがある場合にのみ意味を持つ(無い場合はundefinedへ落とす) */
      apiProvider?: ApiProvider;
      model?: string;
    }
  | { ok: false; error: string };

// 利用者キーの文字種・長さ検証。空文字・空白のみは「未指定」として扱う
// (設定画面で消した直後の空文字がそのまま送られても通常経路に落ちるようにする)。
// エラー文にキーの値そのものは一切載せない(長さも載せない)。
type ApiKeyValidation = { ok: true; key?: string } | { ok: false; error: string };

function validateApiKeyValue(apiKey: unknown): ApiKeyValidation {
  if (apiKey === undefined || apiKey === null) return { ok: true };
  if (typeof apiKey !== 'string') {
    return { ok: false, error: 'apiKeyは文字列で指定してください' };
  }
  const trimmed = apiKey.trim();
  if (trimmed.length === 0) return { ok: true };
  if (trimmed.length > MAX_API_KEY_CHARS) {
    return { ok: false, error: `apiKeyは${MAX_API_KEY_CHARS}文字以下にしてください` };
  }
  if (!API_KEY_PATTERN.test(trimmed)) {
    return { ok: false, error: 'apiKeyに使用できない文字が含まれています' };
  }
  return { ok: true, key: trimmed };
}

type ProviderValidation = { ok: true; provider?: ApiProvider } | { ok: false; error: string };

function validateProviderValue(apiProvider: unknown): ProviderValidation {
  if (apiProvider === undefined || apiProvider === null) return { ok: true };
  if (typeof apiProvider !== 'string' || !VALID_PROVIDERS.has(apiProvider)) {
    return { ok: false, error: 'apiProviderはopenaiまたはanthropicで指定してください' };
  }
  return { ok: true, provider: apiProvider as ApiProvider };
}

type ModelValidation = { ok: true; model?: string } | { ok: false; error: string };

function validateModelValue(model: unknown): ModelValidation {
  if (model === undefined || model === null) return { ok: true };
  if (typeof model !== 'string') {
    return { ok: false, error: 'modelは文字列で指定してください' };
  }
  const trimmed = model.trim();
  if (trimmed.length === 0) return { ok: true };
  if (trimmed.length > MAX_MODEL_CHARS) {
    return { ok: false, error: `modelは${MAX_MODEL_CHARS}文字以下にしてください` };
  }
  if (!MODEL_PATTERN.test(trimmed)) {
    return { ok: false, error: 'modelに使用できない文字が含まれています' };
  }
  return { ok: true, model: trimmed };
}

// 検証ルールはすべてこの関数に閉じる。違反はすべて400・日本語messageで返す想定。
export function validateChatRequest(body: unknown): ChatRequestValidation {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'リクエストボディが不正です' };
  }
  const { messages, system, apiKey, apiProvider, model } = body as {
    messages?: unknown;
    system?: unknown;
    apiKey?: unknown;
    apiProvider?: unknown;
    model?: unknown;
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

  const keyResult = validateApiKeyValue(apiKey);
  if (!keyResult.ok) return { ok: false, error: keyResult.error };

  const providerResult = validateProviderValue(apiProvider);
  if (!providerResult.ok) return { ok: false, error: providerResult.error };

  const modelResult = validateModelValue(model);
  if (!modelResult.ok) return { ok: false, error: modelResult.error };

  // apiProvider・modelは利用者キー経路でのみ有効。サーバー側キーで呼ぶリクエストが
  // プロバイダやモデルを選べてしまうと、運営者負担の費用を利用者が決められることになるため、
  // 値の検証は行った上で捨てる(不正値は上で400にしてある)。
  if (keyResult.key === undefined) {
    return { ok: true, messages: parsed, system: systemText };
  }

  return {
    ok: true,
    messages: parsed,
    system: systemText,
    userApiKey: keyResult.key,
    apiProvider: providerResult.provider,
    model: modelResult.model,
  };
}

export type TestRequestValidation =
  | { ok: true; apiKey: string; apiProvider: ApiProvider; model?: string }
  | { ok: false; error: string };

/**
 * POST /api/ai/test(接続テスト)の検証。チャットと違い、apiKeyとapiProviderは必須
 * (テストする対象が確定していなければ意味が無い)。modelは任意で、未指定なら既定を使う。
 */
export function validateTestRequest(body: unknown): TestRequestValidation {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'リクエストボディが不正です' };
  }
  const { apiKey, apiProvider, model } = body as {
    apiKey?: unknown;
    apiProvider?: unknown;
    model?: unknown;
  };

  const keyResult = validateApiKeyValue(apiKey);
  if (!keyResult.ok) return { ok: false, error: keyResult.error };
  if (keyResult.key === undefined) {
    return { ok: false, error: 'apiKeyを入力してください' };
  }

  const providerResult = validateProviderValue(apiProvider);
  if (!providerResult.ok) return { ok: false, error: providerResult.error };
  if (providerResult.provider === undefined) {
    return { ok: false, error: 'apiProviderはopenaiまたはanthropicで指定してください' };
  }

  const modelResult = validateModelValue(model);
  if (!modelResult.ok) return { ok: false, error: modelResult.error };

  return { ok: true, apiKey: keyResult.key, apiProvider: providerResult.provider, model: modelResult.model };
}

export type AiSuccess = {
  text: string;
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number };
};

export type AiFailure = { status: number; code: string; message: string };

export type AiResult = { ok: true; value: AiSuccess } | { ok: false; error: AiFailure };

/**
 * モデル一覧取得(POST /api/ai/models。providers/openai.ts listOpenAiModels・
 * providers/anthropic.ts listAnthropicModels)の結果。
 * 失敗はチャット・接続テストと同じAiFailure(providers/upstreamError.tsのmapUpstreamError)で表す
 * ため、エンドポイント側のエラー変換を1通りに保てる。
 * このファイルの既存ロジック(resolveCallProvider等の不変条件)には関与しない型定義のみ。
 */
export type ModelListResult = { ok: true; models: string[] } | { ok: false; error: AiFailure };

/** providers/*.tsへ渡す確定済みのパラメータ(既定値の決定はこのファイルに集約する) */
export type ProviderCallOptions = {
  model: string;
  maxTokens: number;
  /** 与えられた場合、providersはサーバー側キーを一切参照しない */
  userApiKey?: string;
};

// AI_PROVIDER未設定時はコード既定で'anthropic'(後方互換)。
export function resolveProvider(env: Env): ApiProvider {
  return env.AI_PROVIDER ?? 'anthropic';
}

/**
 * 上流へ送るモデル名を確定する。
 * 1. 利用者が指定していればそれを使う(利用者キー経路のみ。validateChatRequest参照)
 * 2. サーバー運用中のプロバイダ向けの呼び出しなら AI_MODEL(運用値)
 * 3. それ以外(サーバーはopenai運用で、利用者がanthropicのキーを持ち込んだ等)はそのプロバイダの既定
 *
 * 3が必要な理由: AI_MODELは「運用中のプロバイダのモデルID」であり、別プロバイダへ
 * そのまま渡すと必ず404になる。既定を取り違えないよう、プロバイダが一致する時だけ使う。
 */
export function resolveModel(env: Env, provider: ApiProvider, requested?: string): string {
  if (requested !== undefined && requested !== '') return requested;
  if (provider === resolveProvider(env) && env.AI_MODEL) return env.AI_MODEL;
  return DEFAULT_MODEL[provider];
}

function resolveMaxTokens(env: Env): number {
  return Number(env.AI_MAX_TOKENS ?? '4096');
}

export type CallAiOptions = {
  userApiKey?: string;
  /** userApiKeyがある場合のみ有効。未指定なら'openai'(PR #87時点のクライアントとの後方互換) */
  apiProvider?: ApiProvider;
  model?: string;
};

/**
 * 実際に上流を呼ぶプロバイダ。
 * **利用者キーがある場合は必ず利用者の選択(既定openai)で呼び、AI_PROVIDERを見ない。**
 * 利用者キーが無い場合だけサーバー運用のAI_PROVIDERを使う。
 * この関数が「上限をスキップする条件(index.ts: userApiKey !== undefined)」と
 * 「利用者キーで上流を呼ぶ条件」を一致させる要になっている。
 */
export function resolveCallProvider(env: Env, options: CallAiOptions): ApiProvider {
  if (options.userApiKey !== undefined) return options.apiProvider ?? 'openai';
  return resolveProvider(env);
}

// 呼び先の分岐だけをここで持つ。
// userApiKeyが与えられた場合はそのキーで上流を呼び、サーバー側キーは使わない。
export async function callAi(
  env: Env,
  messages: ChatMessage[],
  system: string | undefined,
  options: CallAiOptions = {}
): Promise<AiResult> {
  const provider = resolveCallProvider(env, options);
  const callOptions: ProviderCallOptions = {
    model: resolveModel(env, provider, options.model),
    maxTokens: resolveMaxTokens(env),
    userApiKey: options.userApiKey,
  };
  if (provider === 'openai') {
    return callOpenAi(env, messages, system, callOptions);
  }
  return callAnthropic(env, messages, system, callOptions);
}

// 接続テストで上流へ送る最小のリクエスト。会話にはならない短文1件で、生成量も絞る
// (利用者の費用負担を最小にするため)。
const CONNECTION_TEST_MESSAGES: ChatMessage[] = [{ role: 'user', content: 'ping' }];
const CONNECTION_TEST_MAX_TOKENS = 16;

export type ConnectionTestResult =
  | {
      ok: true;
      provider: ApiProvider;
      model: string;
      usage: { inputTokens: number; outputTokens: number };
    }
  | { ok: false; error: AiFailure };

/**
 * 利用者キーで上流へ最小のリクエストを1件投げ、実際に通るかを確かめる(要件定義書§5.7の
 * 「接続テスト」の再現)。**必ず利用者キーで呼ぶ**(サーバー側キーへ落ちる経路を持たない)ため、
 * 失敗は常に利用者側の問題として日本語で返せる。回数上限(ai_usage)は消費しない(index.ts)。
 */
export async function runConnectionTest(
  env: Env,
  params: { apiKey: string; apiProvider: ApiProvider; model?: string }
): Promise<ConnectionTestResult> {
  const model = resolveModel(env, params.apiProvider, params.model);
  const callOptions: ProviderCallOptions = {
    model,
    maxTokens: CONNECTION_TEST_MAX_TOKENS,
    userApiKey: params.apiKey,
  };
  const result =
    params.apiProvider === 'openai'
      ? await callOpenAi(env, CONNECTION_TEST_MESSAGES, undefined, callOptions)
      : await callAnthropic(env, CONNECTION_TEST_MESSAGES, undefined, callOptions);

  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, provider: params.apiProvider, model, usage: result.value.usage };
}
