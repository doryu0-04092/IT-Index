// architecture.md §5: 上流(OpenAI Chat Completions / Anthropic Messages)の失敗を、
// クライアント契約のエラーコードと日本語messageへ変換する共通処理。
//
// 1か所に集約する理由: providers/openai.ts と providers/anthropic.ts が同じ分岐
// (401/403・429・4xx・5xx)を持ち、利用者持ち込みキー(BYOK)の対応で両者に同じ
// 追加分岐(user_api_key_invalid / user_model_invalid)が必要になったため。
//
// **上流の応答本文とキーの値は、ここから外へ一切出さない。** 返すのは固定の日本語文言だけで、
// ステータス以外の詳細(上流のメッセージ本文)は捨てる。
import type { AiFailure } from '../ai';

export type UpstreamErrorContext = {
  /** 利用者持ち込みキーで呼んだか。利用者が自分で直せる問題を別コードに分けるために使う */
  usingUserKey: boolean;
  /** 上流の応答がモデル名不明を示していたか(detectModelUnknownの判定結果) */
  modelUnknown: boolean;
};

/**
 * モデル名が無効だったかを上流の応答から判定する。
 * OpenAIは404(またはmodel_not_foundの400)、Anthropicは404 not_found_errorで返すため、
 * その2つのステータスに限って本文を読み、"model"の語を含むかで判定する。
 * 判別できない場合はfalse(汎用のエラー文言に落ちる)。
 *
 * 本文はここで読み切って捨てる(呼び出し元へ返さない)。呼び出し元は同じResponseの
 * bodyを再読しない前提で使う。
 */
export async function detectModelUnknown(res: Response): Promise<boolean> {
  if (res.status !== 400 && res.status !== 404) return false;
  const text = await res.text().catch(() => '');
  return /model/i.test(text);
}

export function mapUpstreamError(status: number, ctx: UpstreamErrorContext): AiFailure {
  if (status === 401 || status === 403) {
    // 利用者キーが無効な場合はサーバー設定の問題と混同させない別コードにする
    // (利用者が自分で直せる問題なので、設定画面へ誘導する文言にする)。
    // 401ではなく400で返すのは、クライアント側で401が「ログインの失効」として
    // 扱われる余地を作らないため(不正なのはリクエストのapiKeyフィールドである)。
    if (ctx.usingUserKey) {
      return {
        status: 400,
        code: 'user_api_key_invalid',
        message: '設定したAPIキーが無効です。設定画面で確認してください',
      };
    }
    return { status: 500, code: 'ai_config_error', message: 'サーバーのAI設定に問題があります' };
  }

  if (ctx.modelUnknown) {
    // モデル名を指定できるのは利用者キー経路だけ(ai.ts)。サーバー側キーでモデル名が
    // 通らないのは運用設定の誤りなので、従来どおりサーバー側の問題として扱う。
    if (ctx.usingUserKey) {
      return {
        status: 400,
        code: 'user_model_invalid',
        message: '指定したモデル名が使えません。設定画面でモデル名を確認してください',
      };
    }
    return { status: 500, code: 'ai_request_invalid', message: 'AIリクエストの組み立てに失敗しました' };
  }

  if (status === 429) {
    // OpenAIはクレジット不足(insufficient_quota)もこのステータスで返すため、
    // レート制限と利用枠超過の両方を汲んだ文言にする。
    return {
      status: 429,
      code: 'ai_upstream_rate_limited',
      message: 'AIが混み合っているか、利用枠を超えています。しばらくして再試行してください',
    };
  }

  // 529はAnthropicのoverloaded。OpenAIは返さないが、分岐を分ける利益が無いので共通で持つ。
  if (status === 529) {
    return { status: 503, code: 'ai_overloaded', message: 'AIが過負荷です' };
  }

  if (status >= 400 && status < 500) {
    return { status: 500, code: 'ai_request_invalid', message: 'AIリクエストの組み立てに失敗しました' };
  }

  return { status: 502, code: 'ai_upstream_error', message: 'AIサービスでエラーが発生しました' };
}
