/**
 * v2\server\src\index.ts が正本のサーバーAPI契約に合わせたクライアント。
 * 新規依存を追加しないため、素のfetchのみを使う(テストはvi.stubGlobal('fetch', ...)でモックする)。
 *
 * ベースURL: 既定は同一オリジンの相対パス"/api"。import.meta.env.VITE_API_BASEが
 * 設定されていれば、それを前置する(開発時にwrangler dev(localhost:8787)を指す用)。
 */

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
  const base = import.meta.env.VITE_API_BASE ?? '';
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

export async function fetchMe(token: string): Promise<{ accountId: string; email: string }> {
  return apiFetch('/auth/me', { method: 'GET', headers: authHeader(token) });
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

/**
 * apiKeyは利用者が自分のOpenAIキーを設定している場合にのみ付ける(BYOK。
 * docs/v2/architecture.md §5)。付けた場合サーバーはそのキーで上流を呼び、回数上限を
 * 適用しない。未設定(undefined・空文字)ならフィールド自体を送らず、サーバー側キー+
 * 回数上限の通常経路になる。
 */
export async function chatWithAi(
  token: string,
  messages: AiProxyMessage[],
  system?: string,
  apiKey?: string | null,
): Promise<AiProxyChatResult> {
  const body: { messages: AiProxyMessage[]; system?: string; apiKey?: string } = { messages };
  if (system !== undefined) body.system = system;
  if (apiKey !== undefined && apiKey !== null && apiKey !== '') body.apiKey = apiKey;

  return apiFetch('/ai/chat', {
    method: 'POST',
    headers: authHeader(token),
    body: JSON.stringify(body),
  });
}

export async function fetchAiQuota(token: string): Promise<{ used: number; limit: number }> {
  return apiFetch('/ai/quota', { method: 'GET', headers: authHeader(token) });
}
