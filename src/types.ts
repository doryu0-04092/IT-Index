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
   * 不変・AIは触らない。本人が用意する「思い出す用」の簡潔な説明（要件定義書§5.2）。
   * origin:'ai' の新規登録語には初期説明という概念自体が無いため null。
   * その場合は notes.body（AI補足）だけが本文として扱われる。
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
  sessionId: string;
  at: number; // epoch ms。(at, id) が通し番号の複合キー
  deviceId: string;
}

/** Drive 同期対象外（過程は共有しない） */
export interface ChatSessionRecord {
  id: string;
  termId: string | null; // null = 自由チャット
  startedAt: number;
  lastActiveAt: number;
  status: 'open' | 'committed';
}

/** Drive 同期対象外 */
export interface ChatMessageRecord {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  at: number;
}

/** Drive 同期対象外。APIキーは含めない */
export interface SettingsRecord {
  key: 'singleton';
  deviceId: string;
  seedVersion: string | null;
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
