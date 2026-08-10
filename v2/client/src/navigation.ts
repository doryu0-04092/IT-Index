/**
 * 画面遷移の型。App.tsxへの責務集中を繰り返さないため(docs/v2/architecture.md §8)、
 * 遷移の型定義・戻り先の判定はここに分離する。v1と異なりルーターは追加せず、
 * state一本(useState<Screen>)で遷移する(要件定義書§4.1「単一レスポンシブUI」)。
 */

/** 単語詳細画面の遷移元。戻るボタンの表示・遷移先の判定に使う */
export type DetailFrom = 'search' | 'index' | 'weighted';

export type Screen =
  | { name: 'search' }
  | { name: 'detail'; termId: string; from: DetailFrom }
  | { name: 'index' }
  | { name: 'weighted' }
  | { name: 'sync' }
  /**
   * AIチャット画面。要件定義書§5.3。戻り先(returnTo)は開いた場所を丸ごと保持する
   * (単語詳細から開けば単語詳細へ、検索の「取り込み待ち」一覧から開けば検索へ戻る)。
   */
  | { name: 'chat'; sessionId: string; returnTo: Screen };

export function screenKey(screen: Screen): string {
  if (screen.name === 'detail') return `detail:${screen.termId}`;
  if (screen.name === 'chat') return `chat:${screen.sessionId}`;
  return screen.name;
}

/** 単語詳細画面の「戻る」リンクの遷移先。検索から来た場合は検索へ、それ以外は元の画面へ */
export function backScreenFor(from: DetailFrom): Screen {
  if (from === 'search') return { name: 'search' };
  if (from === 'index') return { name: 'index' };
  return { name: 'weighted' };
}
