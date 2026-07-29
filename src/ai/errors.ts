import type { AiProvider } from './providers/types';

/**
 * docs/requirements.md §5.7「エラーの日本語翻訳」の実装。
 * ステータスコード→日本語文言の対応はここに集約する（UIやログで文言がバラけないように）。
 * HTTPステータスコードの意味はプロバイダ間でほぼ共通なので、翻訳自体はプロバイダ非依存にしてある。
 * どのプロバイダで起きたかは `provider` に残すのでログ用途に使える。
 */
export class AiApiError extends Error {
  readonly provider: AiProvider;
  readonly status: number;
  readonly rawBody: string;

  constructor(provider: AiProvider, status: number, rawBody: string) {
    super(translateApiError(status));
    this.provider = provider;
    this.status = status;
    this.rawBody = rawBody;
  }
}

export function translateApiError(status: number): string {
  switch (status) {
    case 401:
      return 'APIキーが違います。設定を確認してください。';
    case 403:
      return 'このAPIキーには権限がありません。';
    case 404:
      return 'APIの呼び出し先が見つかりません。';
    case 400:
      return 'リクエストの形式が正しくありません。';
    case 429:
      return 'リクエストが多すぎます。しばらく待って再度お試しください。';
    case 500:
    case 502:
    case 503:
    case 529:
      return 'AI側で一時的な問題が発生しています。しばらく待って再度お試しください。';
    default:
      return `通信エラーが発生しました（${status}）。`;
  }
}
