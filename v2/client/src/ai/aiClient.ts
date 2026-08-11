import { ApiRequestError, chatWithAi } from '../sync/apiClient';
import {
  getVerifiedCredential,
  markCredentialUnverified,
  type AiCredential,
} from '../sync/apiKeyStore';

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
 * 利用者が自分のキーを設定し接続テストに通している場合は、その資格情報(キー+プロバイダ+
 * モデル名)も呼び出しごとに読み直して同送する(BYOK。docs/v2/architecture.md §5)。
 * トークンと同じ理由で毎回読み直す——設定画面で保存/削除した直後から、この参照を
 * 作り直さずに反映される。
 *
 * サーバーがキーを拒否した場合(user_api_key_invalid)はここで検証済みフラグを解除する。
 * 以降の送信は共有キー+回数上限の経路に落ち、設定画面には「無効になっている」ことが出る
 * (無効なキーで送り続けて毎回失敗する状態を作らないため)。
 */
export function createProxyAiClient(
  getToken: () => string | null,
  getCredential: () => AiCredential | null = getVerifiedCredential,
): AiClient {
  return {
    async send(request) {
      const token = getToken();
      if (!token) {
        throw new Error('AIチャットにはログインが必要です');
      }
      const credential = getCredential();
      try {
        return await chatWithAi(token, request.messages, request.system, credential);
      } catch (err) {
        if (credential !== null && err instanceof ApiRequestError && err.code === 'user_api_key_invalid') {
          markCredentialUnverified();
        }
        throw err;
      }
    },
  };
}
