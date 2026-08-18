/**
 * v2\server\src\index.ts が正本のサーバーAPI契約に合わせたクライアント。
 * 新規依存を追加しないため、素のfetchのみを使う(テストはvi.stubGlobal('fetch', ...)でモックする)。
 *
 * ベースURL: 既定は同一オリジンの相対パス"/api"。import.meta.env.VITE_API_BASEが
 * 設定されていれば、それを前置する(開発時にwrangler dev(localhost:8787)を指す用)。
 * さらに、利用者が設定タブ「接続先サーバー」で接続テストに成功したURLを保存していれば
 * それを最優先で使う(sync/serverConfig.ts参照)。認証・同期・AIの全リクエストはこのファイルの
 * apiFetch()を経由するため、apiUrl()の1箇所を読み替えるだけで基底URLが一元的に切り替わる。
 */
import type { CardBrand } from '../lib/cardValidation';
import { getServerBaseUrl } from './serverConfig';

export interface ApiErrorBody {
  code: string;
  message: string;
}

/** サーバーが返す日本語messageをそのまま利用者へ表示するため、messageをErrorのmessageに載せる */
export class ApiRequestError extends Error {
  code: string;
  status: number;
  constructor(body: ApiErrorBody, status: number) {
    super(body.message);
    this.name = 'ApiRequestError';
    this.code = body.code;
    this.status = status;
  }
}

function apiUrl(path: string): string {
  const base = getServerBaseUrl() ?? import.meta.env.VITE_API_BASE ?? '';
  return `${base}/api${path}`;
}

async function apiFetch<T>(path: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
  } catch {
    throw new ApiRequestError({ code: 'network_error', message: 'サーバーに接続できませんでした' }, 0);
  }

  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const errorBody = (body as { error?: ApiErrorBody } | null)?.error;
    throw new ApiRequestError(
      errorBody ?? { code: 'unknown_error', message: '通信に失敗しました' },
      res.status,
    );
  }
  return body as T;
}

function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export async function signup(email: string, password: string): Promise<{ token: string }> {
  return apiFetch('/auth/signup', { method: 'POST', body: JSON.stringify({ email, password }) });
}

export async function login(email: string, password: string): Promise<{ token: string }> {
  return apiFetch('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
}

/** サーバーが持つお支払い方法の表示情報(完全なカード番号・CVCは含まない) */
export interface PaymentMethod {
  brand: CardBrand;
  /** カード番号の下4桁のみ */
  last4: string;
  /** "MM/YY" */
  expiry: string;
  holderName: string;
}

export interface MeResponse {
  accountId: string;
  email: string;
  licensed: boolean;
  /** 本人の有効なライセンスコード。未ライセンスならnull */
  licenseCode: string | null;
  /** 'purchase'=決済モック経由 / 'operator'=運営者コード。課金の有無の判別に使う */
  licenseSource: 'purchase' | 'operator' | null;
  /** 課金開始日(epoch ms)。次回請求日の算出に使う */
  activatedAt: number | null;
  paymentMethod: PaymentMethod | null;
}

export async function fetchMe(token: string): Promise<MeResponse> {
  return apiFetch('/auth/me', { method: 'GET', headers: authHeader(token) });
}

/**
 * お支払い方法(表示情報)の登録・変更。ライセンスが無いアカウントは403
 * (code: 'license_required')。カード番号・CVCは送らない。
 */
export async function savePaymentMethod(
  token: string,
  method: PaymentMethod,
): Promise<{ paymentMethod: PaymentMethod }> {
  return apiFetch('/payment-method', {
    method: 'PUT',
    headers: authHeader(token),
    body: JSON.stringify(method),
  });
}

/** 解約(即時無効)。登録カードも同時に削除される。有効なライセンスが無ければ409 */
export async function cancelLicense(token: string): Promise<{ canceled: true }> {
  return apiFetch('/license/cancel', { method: 'POST', headers: authHeader(token) });
}

/**
 * 決済モック(requirements.md §4.2)。成功時はサーバーが即時発行・有効化したコードを返す
 * (画面で「決済が確定されました。ライセンスコード: {code}」と表示するためのcode)。
 * 既に有効なライセンスがある場合は409(code: 'license_already_active')。
 */
export async function purchaseLicense(token: string): Promise<{ code: string; activatedAt: number }> {
  return apiFetch('/license/purchase', { method: 'POST', headers: authHeader(token) });
}

/** ライセンスコードの有効化。失敗時はサーバーの日本語messageを持つApiRequestError(403/400/429) */
export async function activateLicense(token: string, code: string): Promise<{ activatedAt: number }> {
  return apiFetch('/license/activate', {
    method: 'POST',
    headers: authHeader(token),
    body: JSON.stringify({ code }),
  });
}

export async function pushSyncBlob(token: string, deviceId: string, payload: string): Promise<{ seq: number }> {
  return apiFetch('/sync/push', {
    method: 'POST',
    headers: authHeader(token),
    body: JSON.stringify({ deviceId, payload }),
  });
}

export interface PulledBlob {
  seq: number;
  deviceId: string;
  payload: string;
  createdAt: number;
}

export async function pullSyncBlobs(
  token: string,
  since: number,
): Promise<{ blobs: PulledBlob[]; latest: number }> {
  return apiFetch(`/sync/pull?since=${since}`, { method: 'GET', headers: authHeader(token) });
}

/**
 * v2\server\src\ai.ts / index.ts が正本のAIプロキシ契約。
 * v1と異なり端末からAnthropicを直接呼ばず、必ずこのプロキシ経由で呼ぶ(docs/v2/requirements.md §4.1)。
 */
export interface AiProxyMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiProxyChatResult {
  text: string;
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number };
}

/** 利用者が持ち込むキーの送信単位(sync/apiKeyStore.tsのAiCredentialから作る) */
export interface AiProxyCredential {
  key: string;
  provider: 'openai' | 'anthropic';
  /** 未指定ならサーバー側のプロバイダごとの既定モデルを使う */
  model?: string;
}

/**
 * credentialは利用者が自分のキーを設定し、接続テストに通っている場合にのみ付ける(BYOK。
 * docs/v2/architecture.md §5)。付けた場合サーバーはそのキーで指定プロバイダの上流を呼び、
 * 回数上限を適用しない。未設定(undefined・null・空キー)ならフィールド自体を送らず、
 * サーバー側キー+回数上限の通常経路になる。
 */
export async function chatWithAi(
  token: string,
  messages: AiProxyMessage[],
  system?: string,
  credential?: AiProxyCredential | null,
): Promise<AiProxyChatResult> {
  const body: {
    messages: AiProxyMessage[];
    system?: string;
    apiKey?: string;
    apiProvider?: 'openai' | 'anthropic';
    model?: string;
  } = { messages };
  if (system !== undefined) body.system = system;
  if (credential && credential.key !== '') {
    body.apiKey = credential.key;
    body.apiProvider = credential.provider;
    if (credential.model !== undefined && credential.model !== '') body.model = credential.model;
  }

  return apiFetch('/ai/chat', {
    method: 'POST',
    headers: authHeader(token),
    body: JSON.stringify(body),
  });
}

export interface AiConnectionTestResult {
  ok: true;
  provider: 'openai' | 'anthropic';
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * 利用者のキーが実際に上流へ通るかを確かめる(POST /api/ai/test。要件定義書§5.7の接続テスト)。
 * 失敗時はサーバーが返す日本語messageを持つApiRequestErrorになるため、呼び出し元はそれを
 * そのまま表示すればよい(理由の切り分けはサーバー側のcodeが持つ)。
 */
export async function testAiConnection(
  token: string,
  credential: AiProxyCredential,
): Promise<AiConnectionTestResult> {
  const body: { apiKey: string; apiProvider: 'openai' | 'anthropic'; model?: string } = {
    apiKey: credential.key,
    apiProvider: credential.provider,
  };
  if (credential.model !== undefined && credential.model !== '') body.model = credential.model;

  return apiFetch('/ai/test', {
    method: 'POST',
    headers: authHeader(token),
    body: JSON.stringify(body),
  });
}

export interface AiModelsResult {
  provider: 'openai' | 'anthropic';
  models: string[];
}

/**
 * 利用者のキーで選べるモデルの一覧を取得する(POST /api/ai/models)。
 * **一覧の取得がそのままキーの疎通確認になる**(キーが無効なら400 user_api_key_invalidが返る)
 * ため、設定画面の「接続テスト」はこの関数を呼ぶ(v1 src/ai/providers/index.tsと同じ考え方)。
 * 失敗時はサーバーの日本語messageを持つApiRequestErrorになる。
 */
export async function fetchAiModels(
  token: string,
  credential: { key: string; provider: 'openai' | 'anthropic' },
): Promise<AiModelsResult> {
  return apiFetch('/ai/models', {
    method: 'POST',
    headers: authHeader(token),
    body: JSON.stringify({ apiKey: credential.key, apiProvider: credential.provider }),
  });
}

export async function fetchAiQuota(token: string): Promise<{ used: number; limit: number }> {
  return apiFetch('/ai/quota', { method: 'GET', headers: authHeader(token) });
}
