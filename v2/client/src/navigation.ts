/**
 * 画面遷移の型。App.tsxへの責務集中を繰り返さないため(docs/v2/architecture.md §8)、
 * 遷移の型定義・戻り先の判定はここに分離する。v1と異なりルーターは追加せず、
 * state一本(useState<Screen>)で遷移する(要件定義書§4.1「単一レスポンシブUI」)。
 */

/**
 * 「履歴」タブのサブタブ。時系列を既定・最低限の機能とし、重み付けは個人的に作った
 * 特殊な機能の1つとして2番目に置く(本人指定)。連携履歴・取り込み履歴・競合選択は
 * 将来ここに追加できるよう型だけ拡張可能にしておく(現時点では実装しない)。
 * 'sync' | 'commits' | 'conflicts' を将来追加する想定。
 */
export type HistoryView = 'timeline' | 'weighted';

export type Screen =
  | { name: 'search' }
  /**
   * 単語詳細画面。戻り先(returnTo)は開いた場所を丸ごと保持する(chatと同じ形。
   * 以前はDetailFrom+backScreenFor()で「戻り先の種類」だけを持っていたが、
   * 検索/索引/履歴のどのサブタブから開いても「元の画面に戻る」という同じ目的なので、
   * chatのreturnToと仕組みを1つに統一した)。
   */
  | { name: 'detail'; termId: string; returnTo: Screen }
  | { name: 'index' }
  | { name: 'history'; view: HistoryView }
  | { name: 'sync' }
  /**
   * AIチャット画面。要件定義書§5.3。戻り先(returnTo)は開いた場所を丸ごと保持する
   * (単語詳細から開けば単語詳細へ、検索の「取り込み待ち」一覧から開けば検索へ戻る)。
   */
  | { name: 'chat'; sessionId: string; returnTo: Screen };

export function screenKey(screen: Screen): string {
  if (screen.name === 'detail') return `detail:${screen.termId}`;
  if (screen.name === 'chat') return `chat:${screen.sessionId}`;
  // historyはviewを含めない。サブタブ切替(timeline<->weighted)で<main key={screenKey}>を
  // 再マウントさせない=HistoryScreen内のデータ再取得を起こさないため(サブタブ切替は
  // 表示の並べ替えだけで、asks/termsの取得はタブ間で共通・不変)。
  return screen.name;
}
