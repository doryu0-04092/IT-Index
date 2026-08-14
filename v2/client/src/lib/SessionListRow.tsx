import type { ReactNode } from 'react';
import type { SessionLabelRow } from './chatSessionLabels';

export interface SessionListRowProps {
  row: SessionLabelRow;
  /** ラベル部分を押した時の動作(検索画面: チャットへ戻る/履歴画面: チャットを開く) */
  onSelect: () => void;
  /** 前回の取り込みに失敗した(検索画面「取り込み待ち」限定。v1 #41由来) */
  failed?: boolean;
  /** ラベル・日時に添える補足(履歴画面「取り込み履歴」タブの状態バッジ)。渡さない画面には出ない */
  meta?: ReactNode;
  /** 右端に横並びで置く操作ボタン群(取り込む・登録しない等) */
  children: ReactNode;
}

/**
 * 検索画面「取り込み待ち」・履歴画面「取り込み履歴」タブで共通の行表示(依頼者指示:
 * 履歴の「時系列」「重み付け」タブの行(.result-row/.result-button。HistoryScreen.tsx参照)
 * と見た目を揃える)。枠・padding・hoverはそちらの.result-row/.result-buttonをそのまま
 * 再利用し、右側にだけ操作ボタン群(children)を足す——時系列・重み付けの行との違いは
 * 右側の操作ボタンと状態バッジ(meta)の有無だけ、という状態にする。
 *
 * .result-buttonは本来<button>だが、ここは内側にさらに操作ボタン(取り込む等)を並べる
 * 必要があり<button>は入れ子にできない(HTML上無効)。そのため外枠は<div
 * className="result-button">にし、ラベル部分だけを内側の<button>にする
 * (行本体=ラベル部分のタップでonSelectが呼ばれる、という既存挙動は変えていない)。
 *
 * 日時(row.session.lastActiveAt)は時系列の行と同じtoLocaleString('ja-JP')書式で、
 * このコンポーネントが常に表示する(検索・履歴の両方で必要なため、呼び出し側での
 * 重複した組み立てを避ける)。
 *
 * データ取得(lib/chatSessionLabels.ts loadSessionLabelRows)は引き続き呼び出し側が担う
 * ——このコンポーネントは行の見た目の組み立てだけを持つ。
 */
export default function SessionListRow({ row, onSelect, failed, meta, children }: SessionListRowProps) {
  return (
    <li className="result-row">
      <div className="result-button session-list-row">
        <button type="button" className="search-pending-item" onClick={onSelect}>
          <span className="result-term">{row.label}</span>
          {meta}
          <span className="result-field">{new Date(row.session.lastActiveAt).toLocaleString('ja-JP')}</span>
          {failed && <span className="error-text search-pending-failed">前回の取り込みに失敗しました</span>}
        </button>
        <div className="session-list-actions">{children}</div>
      </div>
    </li>
  );
}
