import type { ReactNode } from 'react';
import type { SessionLabelRow } from './chatSessionLabels';

export interface SessionListRowProps {
  row: SessionLabelRow;
  /** ラベル部分を押した時の動作(検索画面: チャットへ戻る/履歴画面: チャットを開く) */
  onSelect: () => void;
  /** 前回の取り込みに失敗した(検索画面「取り込み待ち」限定。v1 #41由来) */
  failed?: boolean;
  /** ラベルに添える補足(履歴画面の日時等)。渡さない画面には出ない */
  meta?: ReactNode;
  /** 右端に横並びで置く操作ボタン群(取り込む・登録しない等) */
  children: ReactNode;
}

/**
 * 検索画面「取り込み待ち」・履歴画面「取り込み履歴」タブで共通の行表示(依頼者指示
 * 「リンクさせる」)。#115で整えたレイアウト(.search-pending-row: display:flexでラベル側を
 * 伸ばし、操作ボタンは右端に横並び。App.css参照)をここに集約する——従来はSearchScreen.tsx・
 * HistoryScreen.tsxがそれぞれ個別にこの行を組み立てており、片方だけ直して他方がずれる
 * (クラス名・構造が食い違う)構造になっていた。
 *
 * データ取得(lib/chatSessionLabels.ts loadSessionLabelRows)は引き続き呼び出し側が担う
 * ——このコンポーネントは行の見た目の組み立てだけを持つ。
 */
export default function SessionListRow({ row, onSelect, failed, meta, children }: SessionListRowProps) {
  return (
    <li className="search-pending-row">
      <button type="button" className="btn-text search-pending-item" onClick={onSelect}>
        {row.label}
        {meta}
        {failed && <span className="error-text search-pending-failed">前回の取り込みに失敗しました</span>}
      </button>
      {children}
    </li>
  );
}
