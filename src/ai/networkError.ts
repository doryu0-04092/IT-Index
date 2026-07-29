/**
 * fetch() は、HTTPステータスが返る「APIエラー」とは別に、CORSブロック・オフライン・
 * DNS失敗などで**reject**することがある（典型的には `TypeError: Failed to fetch`）。
 * この場合 `res`（Responseオブジェクト）自体が存在しないため、ステータスコード前提の
 * `AiApiError`/`translateApiError`（src/ai/errors.ts）に到達する経路が構造的に無く、
 * 未翻訳の英語エラーがそのまま利用者に表示されてしまっていた（実際に報告された不具合。
 * docs/ui-pc.md バグ8参照）。各プロバイダの `fetch()` 呼び出しをこの関数越しに行うことで、
 * reject時だけ日本語の案内文に変換する（resolve後のHTTPステータス処理は今まで通り）。
 */
export async function fetchOrTranslateNetworkError(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    throw new Error(
      'AIサービスに接続できませんでした（ネットワークの問題、またはブラウザ・拡張機能による通信制限の可能性があります）。時間をおいて再度お試しください。',
    );
  }
}
