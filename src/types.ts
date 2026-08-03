import type { AiProvider } from './ai/providers/types';

/**
 * データ層の型定義。docs/data-layer.md §2 の正本実装。
 * ER図の対応関係は docs/architecture.md §2 を参照。
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

/** Drive 同期対象外（配信データ由来）。origin:'ai' の語のみ例外的に同期対象 */
export interface TermRecord {
  id: string; // = normalize(term)
  term: string;
  readings: string[]; // 原則1要素
  /**
   * 不変（一度書かれたら二度と上書きしない。要件定義書§5.2）。
   * origin:'seed' は本人が用意。origin:'ai' は新規登録の瞬間にAIが1回だけ生成する
   * （2026-07-29決定。それ以前は origin:'ai' には概念自体が無く常に null だった）。
   * どちらの origin でも、登録後の統合（merge）では一切書き換えない。
   * null は主にこの変更以前に登録された古い origin:'ai' レコードの後方互換用。
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

/** Drive 同期対象（端末ごとに育つ唯一のデータ） */
export interface NoteRecord {
  termId: string; // PK = FK（1用語1件）
  body: string; // Markdown
  diagrams: string[]; // Mermaid文字列。body とは独立して壊れてよい
  updatedAt: number;
  lastEditedBy: string; // deviceId
  noteHistory: NoteHistoryEntry[]; // 同期対象外。ロールバック用
}

/** Drive 同期対象（追記のみ・idで和集合） */
export interface AskRecord {
  id: string;
  termId: string;
  /** AIチャットの確定由来なら該当セッションID。ローカル検索の確定由来（source:'search'）は null */
  sessionId: string | null;
  at: number; // epoch ms。(at, id) が通し番号の複合キー
  deviceId: string;
  /**
   * 'ai' = AIチャットの確定で加算（従来どおり）。
   * 'search' = ローカル検索結果から用語詳細を開いた「確定」で加算（2026-07-29追加。要件定義書§5.4）。
   * 重み付けの倍率が異なる（src/core/computeWeights.ts）。未設定（この変更以前のレコード）は 'ai' 扱いにする。
   */
  source: 'ai' | 'search';
}

/** Drive 同期対象外（過程は共有しない） */
export interface ChatSessionRecord {
  id: string;
  termId: string | null; // null = 自由チャット
  startedAt: number;
  lastActiveAt: number;
  status: 'open' | 'committed';
  /**
   * ローカルデータ層（docs/local-data.md §6.1）。`data/pending/<termId>.md` を一度でも
   * 書き出したら、その時刻（epoch ms）を記録する。次回以降、書き出し先にファイルが無ければ
   * 「Claude Code が処理を終えて削除した」とみなし、このセッションを自動的に commit する。
   * まだ一度も書き出していない（＝ファイルが無いのは単に新規だから）場合と区別するために必須。
   * 未書き出しなら null。
   */
  pendingExportedAt: number | null;
}

/** Drive 同期対象外 */
export interface ChatMessageRecord {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  at: number;
  /**
   * クイック質問（「単語の概要を聞く」「さらに詳しく聞く」）で自動送信した定型文かどうか。
   * true の場合はチャット画面に表示しない。省略時（既存レコード含む）はfalse相当（表示する）。
   * 以前はコンポーネントのローカルstateだけで非表示管理していたため、チャット履歴を
   * 再度開き直す（セッション再開・リロード復元）と定型文が見えてしまう不具合があった。
   */
  hidden?: boolean;
}

/** Drive 同期対象外。APIキーは含めない */
export interface SettingsRecord {
  key: 'singleton';
  deviceId: string;
  seedVersion: string | null;
  /**
   * 既存語への追記（統合）を自動保存する範囲（2026-07-30追加。要件定義書§5.3）。
   * 'askedOnly'（既定）＝利用者自身が尋ねた語（askedByUser:true）だけを自動保存する。
   * 'all' ＝ 他の語についての会話で言及されただけの語（askedByUser:false）も自動保存する。
   * 新規語の登録は常に askedByUser:true が必須（この設定の対象外。distribution.ts参照）。
   */
  autoUpdateExistingTerms: 'askedOnly' | 'all';
  /**
   * ローカルデータ層（docs/local-data.md）。`data/terms.json` の最終取り込み時に記録した
   * `lastModified`（epoch ms）。次回起動時、ファイルのこの値と比較して変化が無ければ
   * 取り込み処理そのものをスキップする（3510語規模の再パースを避けるため）。
   * まだ一度もフォルダを選んでいない・取り込んでいなければ null。
   */
  localTermsLastModified: number | null;
}

/**
 * Drive 同期対象外。APIキーの暗号化保存が明示的にオプトインされた場合のみ1行できる
 * （既定はセッションのみでこのテーブル自体が空のまま）。
 * `credentialId` はパスキーの識別子で秘匿情報ではない。復号には毎回 WebAuthn PRF を要する。
 * `provider`/`model` はどのAIプロバイダ・モデル向けの鍵かを示す（秘匿情報ではないので平文）。
 */
export interface KeyStoreRecord {
  key: 'singleton';
  provider: AiProvider;
  model: string;
  credentialId: ArrayBuffer;
  ciphertext: ArrayBuffer;
  iv: Uint8Array<ArrayBuffer>;
}

/**
 * Drive 同期対象外。手動同期の「共有フォルダ方式」（docs/manual-sync.md）で選んだ
 * フォルダの参照を次回起動時にも使えるよう保持する。FileSystemDirectoryHandle は
 * 構造化複製可能なため IndexedDB にそのまま保存できる（Chrome 86+）。
 * 権限（readwrite）は保存されないため、使用時に毎回 queryPermission/requestPermission が要る。
 */
export interface SyncFolderRecord {
  key: 'singleton';
  handle: FileSystemDirectoryHandle;
}
