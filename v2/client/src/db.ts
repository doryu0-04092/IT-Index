import Dexie, { type Table } from 'dexie';
import type { AskRecord, NoteRecord, TermRecord } from '@it-index/shared';
import type { NoteConflictRecord, SettingsRecord, SyncStateRecord } from './types';

/**
 * v1(../../src/db.ts)のDexie設計を踏襲する。
 * バージョン番号を上げる時は既存のversion(n)定義を書き換えず、新しいversion(n+1)を追加すること
 * (v1のコメントと同じ作法)。
 *
 * version 2(サーバーリレー同期。docs/v2/architecture.md §3): syncState・noteConflictsを追加。
 * 既存4テーブル(terms/notes/asks/settings)のストア定義はversion 1のまま変更しない。
 */
export class ItIndexDB extends Dexie {
  terms!: Table<TermRecord, string>;
  notes!: Table<NoteRecord, string>;
  asks!: Table<AskRecord, string>;
  settings!: Table<SettingsRecord, string>;
  syncState!: Table<SyncStateRecord, string>;
  noteConflicts!: Table<NoteConflictRecord, string>;

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
  }
}

export const db = new ItIndexDB();
