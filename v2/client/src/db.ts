import Dexie, { type Table } from 'dexie';
import type { AskRecord, NoteRecord, TermRecord } from '@it-index/shared';
import type {
  ChatMessageRecord,
  ChatSessionRecord,
  NoteConflictRecord,
  SettingsRecord,
  SyncEventRecord,
  SyncStateRecord,
} from './types';

/**
 * v1(../../src/db.ts)のDexie設計を踏襲する。
 * バージョン番号を上げる時は既存のversion(n)定義を書き換えず、新しいversion(n+1)を追加すること
 * (v1のコメントと同じ作法)。
 *
 * version 2(サーバーリレー同期。docs/v2/architecture.md §3): syncState・noteConflictsを追加。
 * 既存4テーブル(terms/notes/asks/settings)のストア定義はversion 1のまま変更しない。
 *
 * version 3(AIチャットと分配統合。v1 ../../src/db.ts参照): chatSessions・chatMessagesを追加。
 * チャットは同期対象外(sync/localSnapshot.tsが組み立てるスナップショットに含めない)。
 *
 * version 4(#157 競合と同期履歴のリンク): syncEventsを追加し、noteConflictsに
 * syncEventId索引を追加。既存の競合行はupgradeで新フィールド(syncEventId/closedReason/
 * closedAt)をnullに正規化する——旧行は同期画面には出ず履歴タブにのみ出る。
 */
export class ItIndexDB extends Dexie {
  terms!: Table<TermRecord, string>;
  notes!: Table<NoteRecord, string>;
  asks!: Table<AskRecord, string>;
  settings!: Table<SettingsRecord, string>;
  syncState!: Table<SyncStateRecord, string>;
  noteConflicts!: Table<NoteConflictRecord, string>;
  chatSessions!: Table<ChatSessionRecord, string>;
  chatMessages!: Table<ChatMessageRecord, string>;
  syncEvents!: Table<SyncEventRecord, string>;

  constructor(name = 'it-index-v2') {
    super(name);
    this.version(1).stores({
      terms: 'id',
      notes: 'termId',
      asks: 'id, termId, at',
      settings: 'key',
    });
    this.version(2).stores({
      syncState: 'key',
      noteConflicts: 'id, termId, detectedAt',
    });
    this.version(3).stores({
      chatSessions: 'id, status, termId',
      chatMessages: 'id, sessionId, at',
    });
    this.version(4)
      .stores({
        noteConflicts: 'id, termId, detectedAt, syncEventId',
        syncEvents: 'id, at',
      })
      .upgrade(async (tx) => {
        await tx
          .table('noteConflicts')
          .toCollection()
          .modify((c: NoteConflictRecord) => {
            c.syncEventId ??= null;
            c.closedReason ??= null;
            c.closedAt ??= null;
          });
      });
  }
}

export const db = new ItIndexDB();
