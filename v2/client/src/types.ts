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
