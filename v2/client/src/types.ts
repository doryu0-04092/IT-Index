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
  /**
   * リレーへの自動push(#177/#169)の「push待ち」印(#179)。write-ahead方式:
   * pushを試みる**前**にここへ時刻を書き、成功したらnullへ戻す。失敗・クラッシュしても
   * 意図が残り、起動時・オンライン復帰時・次の自動push時に再試行される。
   * 実行予定フラグの喪失は意図の破損に当たるため、取り込み(確定)では
   * commitProposalと同一トランザクションで立てる(ai/commitOrchestrator.ts)。
   * 旧レコード(このフィールドが無い行)はrepositories/settings.tsのget()でnullに正規化する。
   */
  pendingAutoPushAt: number | null;
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
 * 1回の「今すぐ同期」実行の記録(#157)。競合(NoteConflictRecord.syncEventId)はここへリンクし、
 * 「どの同期でこの競合が発生・持ち越されたか」を辿れるようにする——v1のsyncEventsが競合と
 * 参照関係を持たず突合できなかった反省による。端末ローカルの記録で同期対象外。
 */
export interface SyncEventRecord {
  id: string;
  /** 同期開始時刻(epoch ms) */
  at: number;
  /** push成功時のseq。push失敗で始まらなかった同期は記録自体を作らない */
  pushedSeq: number | null;
  receivedBlobs: number;
  skippedBlobs: number;
  /** この同期に紐づく競合件数(新規+持ち越し)。照合フェーズ完了時に確定する */
  conflictCount: number;
  /** 受信して検証に通ったblobのdeviceId(重複除去) */
  peerDeviceIds: string[];
  /** pullが完走したか。falseのまま残っていれば途中失敗の痕跡 */
  completed: boolean;
}

/**
 * v1のNoteConflictRecord相当(../../src/types.ts参照)。AI統合(merged)を実装する
 * (docs不使用の依頼により、v1と同じ3択(local/remote/merged)・mergedキャッシュを持つ)。
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
  resolution: 'local' | 'remote' | 'merged' | null;
  /**
   * AIで統合した結果のキャッシュ(v1 ../../src/types.ts参照)。'merged'を一度選ぶと保存され、
   * その後local/remoteへ選び直しても消さない——再度「AIで統合する」を選ぶ時に
   * 再呼び出しせず再利用するため。
   */
  merged: { body: string; diagrams: string[] } | null;
  resolvedAt: number | null;
  /**
   * この競合が最後に検出/持ち越された同期イベント(#157)。Dexie version 3以前の
   * 旧レコードはnull(同期画面には出さず履歴タブにのみ出る)。
   */
  syncEventId: string | null;
  /**
   * 利用者の選択(resolution)とは別軸の自動クローズ(#157)。
   * - 'peer-decision': 相手側(PC)の解消結果を採用して統一した(Androidネイティブのみ発生)
   * - 'converged': **その相手の版を受信し、この端末の現在の内容と一致した**(#224)
   * - 'superseded': #224以前の自動クローズ。「その語のnoteを受信した」だけで閉じていたため、
   *   差が残っている競合まで「解消済み」になっていた。**もう書き込まない**が、
   *   既存の記録が残るため型からは外さない
   *
   * openの定義 = resolution===null && closedReason===null
   */
  closedReason: 'peer-decision' | 'converged' | 'superseded' | null;
  closedAt: number | null;
}
