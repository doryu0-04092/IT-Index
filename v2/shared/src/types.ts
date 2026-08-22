/**
 * v2共有の型定義。v1の src/types.ts から、純関数コア・同期プロトコルが使う型のみ移植。
 * 端末側のみで使う型(ChatSession/Settings/KeyStore等)はclient側で定義する。
 * フィールドの意味・経緯のコメントはv1を正とする(docs/data-layer.md §2)。
 *
 * v2で予定している変更(docs/v2/architecture.md §3): TermRecordへの createdBy 追加。
 * 同期プロトコル実装(Phase 1後半)で入れる。ここでは移植時点のv1と同一に保つ。
 */

/** テクノロジ系・マネジメント系・ストラテジ系の24分類。docs/seed-format.md §5 が正本 */
export type Field =
  | '基礎理論'
  | 'アルゴリズムとプログラミング'
  | 'コンピュータ構成要素'
  | 'システム構成要素'
  | 'ソフトウェア'
  | 'ハードウェア'
  | 'ヒューマンインタフェース'
  | 'マルチメディア'
  | 'データベース'
  | 'ネットワーク'
  | 'セキュリティ'
  | 'システム開発技術'
  | 'ソフトウェア開発管理技術'
  | 'AI'
  | 'プロジェクトマネジメント'
  | 'サービスマネジメント'
  | 'システム監査'
  | 'システム戦略'
  | 'システム企画'
  | '経営戦略マネジメント'
  | '技術戦略マネジメント'
  | 'ビジネスインダストリ'
  | '企業活動'
  | '法務';

export const FIELDS: readonly Field[] = [
  '基礎理論',
  'アルゴリズムとプログラミング',
  'コンピュータ構成要素',
  'システム構成要素',
  'ソフトウェア',
  'ハードウェア',
  'ヒューマンインタフェース',
  'マルチメディア',
  'データベース',
  'ネットワーク',
  'セキュリティ',
  'システム開発技術',
  'ソフトウェア開発管理技術',
  'AI',
  'プロジェクトマネジメント',
  'サービスマネジメント',
  'システム監査',
  'システム戦略',
  'システム企画',
  '経営戦略マネジメント',
  '技術戦略マネジメント',
  'ビジネスインダストリ',
  '企業活動',
  '法務',
] as const;

/** 原則同期対象外(配信データ由来)。origin:'ai' の語のみ例外的に同期対象 */
export interface TermRecord {
  id: string; // = normalize(term)
  term: string;
  readings: string[]; // 原則1要素
  /**
   * 不変(一度書かれたら二度と上書きしない。要件定義書§5.2)。
   * origin:'seed' は本人が用意。origin:'ai' は新規登録の瞬間にAIが1回だけ生成する。
   * どちらの origin でも、登録後の統合(merge)では一切書き換えない。
   * null は主に古い origin:'ai' レコードの後方互換用。
   */
  summary: string | null;
  field: Field;
  tags: string[]; // 省略時は []
  searchKey: string; // normalize(term)、事前計算
  readingKeys: string[]; // readings.map(normalize)、事前計算
  origin: 'seed' | 'ai';
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null; // tombstone。null = 未削除
}

export interface NoteHistoryEntry {
  body: string;
  diagrams: string[];
  updatedAt: number;
}

/** 同期対象(端末ごとに育つ唯一のデータ) */
export interface NoteRecord {
  termId: string; // PK = FK(1用語1件)
  body: string; // Markdown
  diagrams: string[]; // Mermaid文字列。body とは独立して壊れてよい
  updatedAt: number;
  lastEditedBy: string; // deviceId
  /**
   * **この版が競合の解消の結果なら、その時刻(#234)。** 通常の編集では null。
   *
   * 「競合の解消をして初めて他の端末でも共有される」を成立させるために要る。
   * 以前は「相手の版が競合検出時より新しければ相手の決定とみなす」という推定で、
   * **解消と単なる追加編集を区別できなかった**——結果として、利用者が何もしていないのに
   * 相手の追加編集で自分の本文が置き換わっていた。
   *
   * **同期対象**(相手の端末がこれを見て採否を決める)。noteHistoryと違い落とさない。
   */
  resolvedAt: number | null;
  noteHistory: NoteHistoryEntry[]; // 同期対象外。ロールバック用
}

/** 同期対象(追記のみ・idで和集合) */
export interface AskRecord {
  id: string;
  termId: string;
  /** AIチャットの確定由来なら該当セッションID。ローカル検索の確定由来(source:'search')は null */
  sessionId: string | null;
  at: number; // epoch ms。(at, id) が通し番号の複合キー
  deviceId: string;
  /**
   * 'ai' = AIチャットの確定で加算。'search' = ローカル検索結果から用語詳細を開いた「確定」で加算。
   * 重み付けの倍率が異なる(core/computeWeights.ts)。未設定の古いレコードは 'ai' 扱い。
   */
  source: 'ai' | 'search';
}
