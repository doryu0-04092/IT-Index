import { AiApiError } from './errors';

/**
 * UIには要件定義書§5.7の翻訳済み文言だけを見せる一方、実際の原因（ステータスコード・
 * プロバイダ・生のレスポンス本文）が分からないと調査できない。開発者コンソールにだけ
 * 詳細を出す（利用者への表示はこれまでどおり翻訳済みメッセージのみ）。
 */
export function logAiError(context: string, err: unknown): void {
  // 第一引数を固定のフォーマット文字列にし、contextは%sの引数として渡す
  // （動的な文字列をフォーマット文字列自体に使うとログ偽造の余地が生まれるため。semgrep unsafe-formatstring対応）。
  if (err instanceof AiApiError) {
    console.error('[%s] AiApiError', context, {
      provider: err.provider,
      status: err.status,
      rawBody: err.rawBody,
      message: err.message,
    });
  } else {
    console.error('[%s]', context, err);
  }
}
