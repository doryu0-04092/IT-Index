import type { NoteRecord } from '@it-index/shared';

/**
 * v2クライアント端末内のみで使う型。@it-index/shared(変更禁止)には置かない
 * ——sharedは端末・サーバー間で共有する型・純関数だけを持つ(docs/v2/architecture.md §8)。
 */

/** 同期対象外。APIキーは含めない(v2はPhase 1の間、端末内キー保管自体を持たない) */
export interface SettingsRecord {
  key: 'singleton';
  deviceId: string;
  seedVersion: string | null;
  /**
   * 既存語への追記(統合)を自動保存する範囲(v1 ../../src/types.ts参照。要件定義書§5.3)。
   * 'askedOnly'(既定) = 利用者自身が尋ねた語(askedByUser:true)だけを自動保存する。
   * 'all' = 他の語についての会話で言及されただけの語(askedByUser:false)も自動保存する。
   * 新規語の登録は常にaskedByUser:trueが必須(この設定の対象外。ai/distribution.ts参照)。
   * UIは設けない(既定値'askedOnly'で動作する。issue範囲外)。
   */
  autoUpdateExistingTerms: 'askedOnly' | 'all';
}

/**
 * Drive同期対象外(過程は共有しない。v1 ../../src/types.ts参照)。
 * チャットは既存の同期スナップショット(sync/localSnapshot.ts)に含めない。
 */
export interface ChatSessionRecord {
  id: string;
  /** 登録済みの語にひも付くチャットならそのid。検索欄からの「AIで検索」ではnull */
  termId: string | null;
  /**
   * termId:null(検索欄からの「AIで検索」)のとき、利用者が入力した文字列。
   * 検索画面の「取り込み待ち」一覧に何のチャットか表示するために要る。
   */
  subjectLabel?: string;
  startedAt: number;
  lastActiveAt: number;
  /**
   * 'open' = 取り込み待ち。'committing' = 取り込み処理の実行中(再開・再取り込みの対象外。
   * v1 ../../src/types.ts のコメント参照——外さないと処理中に同じ語を開いた場合に
   * 発言が黙って捨てられる不具合が再発する)。'committed' = 取り込み済み。
   * 'declined' = 利用者が「登録しない」を選んだ(会話は削除しない)。
   */
  status: 'open' | 'committing' | 'committed' | 'declined';
}

/** Drive同期対象外 */
export interface ChatMessageRecord {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  at: number;
  /** クイック質問等の定型送信文かどうか。trueの場合はチャット画面に表示しない */
  hidden?: boolean;
}

/**
 * リレーと最後に同期した位置(docs/v2/architecture.md §3「syncEvents → syncState」)。
 * v1のピア単位の履歴と異なり、リレー1本のためカーソルは1本で足りる。
 */
export interface SyncStateRecord {
  key: 'singleton';
  cursor: number;
}

/**
 * v1のNoteConflictRecord相当(../../src/types.ts参照)。v2はAI統合(merged)を実装しないため
 * resolutionは'local'|'remote'のみ、mergedフィールドは持たない。
 */
export interface NoteConflictRecord {
  id: string;
  termId: string;
  detectedAt: number;
  /** 相手端末のdeviceId。表示には使わず、どの取り込みで検出したかの記録用 */
  peerDeviceId: string;
  /** 検出時点のこの端末側の内容(不変) */
  local: NoteRecord;
  /** 検出時点の相手端末側の内容(不変) */
  remote: NoteRecord;
  /** 現在採用中の選択。未解決ならnull */
  resolution: 'local' | 'remote' | null;
  resolvedAt: number | null;
}
