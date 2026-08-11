import { chatWithAi } from '../sync/apiClient';
import { getApiKey as getStoredApiKey } from '../sync/apiKeyStore';

/**
 * v1(../../../src/ai/aiClient.ts)のプロバイダ非依存契約を踏襲するが、v2は呼び出し経路が
 * 1つ(v2サーバーのAIプロキシ)に固定されているため、プロバイダ切り替えの抽象化は持たない
 * (docs/v2/requirements.md §4.1「呼び出し経路だけAIプロキシ経由に変わる」)。
 */
export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiRequest {
  system?: string;
  messages: AiMessage[];
}

/**
 * v1の`send(): Promise<string>`と異なり、stopReasonを呼び出し元(chat.ts)が見て
 * refusal時の案内文へ差し替えられるようにする(v2\server\src\ai.ts「stop_reason==="refusal"は
 * 成功扱いで返す」契約に対応するため。text自体は空になりうる)。
 */
export interface AiSendResult {
  text: string;
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface AiClient {
  send(request: AiRequest): Promise<AiSendResult>;
}

/**
 * 端末からAnthropicを直接呼ばず、必ずv2サーバーのAIプロキシ(POST /api/ai/chat)を呼ぶ実装。
 * トークンは呼び出しごとに`getToken()`で読み直す(ログイン状態が変わってもクライアントの
 * 参照を作り直す必要が無いようにする。v1のcreateDynamicAiClient()と同じ考え方)。
 * 未ログイン時にAPIを呼ばないための最終防御として、トークンが無ければここで例外にする
 * (呼び出し元のUI側でも「ログインが必要です」と案内した上でチャット入口を塞ぐ。二重の防御)。
 *
 * 利用者が自分のOpenAIキーを設定している場合はそれも呼び出しごとに読み直して同送する
 * (BYOK。docs/v2/architecture.md §5)。トークンと同じ理由で毎回読み直す——設定画面で
 * キーを保存/削除した直後から、この参照を作り直さずに反映される。
 */
export function createProxyAiClient(
  getToken: () => string | null,
  getApiKey: () => string | null = getStoredApiKey,
): AiClient {
  return {
    async send(request) {
      const token = getToken();
      if (!token) {
        throw new Error('AIチャットにはログインが必要です');
      }
      const result = await chatWithAi(token, request.messages, request.system, getApiKey());
      return result;
    },
  };
}
