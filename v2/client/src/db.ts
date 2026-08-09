import Dexie, { type Table } from 'dexie';
import type { AskRecord, NoteRecord, TermRecord } from '@it-index/shared';
import type { SettingsRecord } from './types';

/**
 * v1(../../src/db.ts)のDexie設計を踏襲する。v2はまだchatSessions/chatMessages/keyStore等を
 * 持たない(要件定義書§4.1「残す」機能のみ移植。チャット・同期は後続PR)。
 * バージョン番号を上げる時は既存のversion(n)定義を書き換えず、新しいversion(n+1)を追加すること
 * (v1のコメントと同じ作法)。
 */
export class ItIndexDB extends Dexie {
  terms!: Table<TermRecord, string>;
  notes!: Table<NoteRecord, string>;
  asks!: Table<AskRecord, string>;
  settings!: Table<SettingsRecord, string>;

  constructor(name = 'it-index-v2') {
    super(name);
    this.version(1).stores({
      terms: 'id',
      notes: 'termId',
      asks: 'id, termId, at',
      settings: 'key',
    });
  }
}

export const db = new ItIndexDB();
