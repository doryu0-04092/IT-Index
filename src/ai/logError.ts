import { AiApiError } from './errors';

/**
 * UIには要件定義書§5.7の翻訳済み文言だけを見せる一方、実際の原因（ステータスコード・
 * プロバイダ・生のレスポンス本文）が分からないと調査できない。開発者コンソールにだけ
 * 詳細を出す（利用者への表示はこれまでどおり翻訳済みメッセージのみ）。
 */
export function logAiError(context: string, err: unknown): void {
  if (err instanceof AiApiError) {
    console.error(`[${context}] AiApiError`, {
      provider: err.provider,
      status: err.status,
      rawBody: err.rawBody,
      message: err.message,
    });
  } else {
    console.error(`[${context}]`, err);
  }
}
