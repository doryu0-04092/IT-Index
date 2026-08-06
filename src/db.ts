import Dexie, { type Table } from 'dexie';
import type {
  AskRecord,
  ChatMessageRecord,
  ChatSessionRecord,
  KeyStoreRecord,
  NoteConflictRecord,
  NoteRecord,
  SettingsRecord,
  SyncEventRecord,
  TermRecord,
} from './types';

/**
 * Dexie バージョン番号は seed-format.md の schemaVersion / architecture.md の
 * syncSchemaVersion とは別物（ローカルDBの構造だけを表す）。
 * 変更する際は既存の version(n) 定義を書き換えず、新しい version(n+1) を追加すること。
 */
export class ItIndexDB extends Dexie {
  terms!: Table<TermRecord, string>;
  notes!: Table<NoteRecord, string>;
  asks!: Table<AskRecord, string>;
  chatSessions!: Table<ChatSessionRecord, string>;
  chatMessages!: Table<ChatMessageRecord, string>;
  settings!: Table<SettingsRecord, string>;
  keyStore!: Table<KeyStoreRecord, string>;
  syncEvents!: Table<SyncEventRecord, string>;
  noteConflicts!: Table<NoteConflictRecord, string>;

  constructor(name = 'it-index') {
    super(name);
    this.version(1).stores({
      terms: 'id, field, origin, deletedAt',
      notes: 'termId, updatedAt',
      asks: 'id, termId, sessionId, [at+id]',
      chatSessions: 'id, termId, status, lastActiveAt',
      chatMessages: 'id, sessionId, at',
      settings: 'key',
    });
    // v2: 鍵ストア追加（APIキーの暗号化保存が明示オプトインされた場合のみ使う。同期対象外）
    this.version(2).stores({
      keyStore: 'key',
    });
    // v3: 手動同期「共有フォルダ方式」で選んだフォルダの参照を保持。同期対象外
    this.version(3).stores({
      syncFolder: 'key',
    });
    // v4: syncFolder を削除。Claude Code によるローカルフォルダ編集機能を廃止したため
    // （2026-08-03）、このテーブルを読み書きするコードがどこにも無くなった。
    // 既存定義を書き換えず、新しい version で null を指定して落とす（Dexieの作法）。
    this.version(4).stores({
      syncFolder: null,
    });
    // v5: 連携（QR）の取り込み履歴。端末ローカルのみ・同期対象外
    this.version(5).stores({
      syncEvents: 'id, at',
    });
    // v6: 連携（QR）で検出された「両端末が独自に編集した」競合の記録。端末ローカルのみ・
    // 同期対象外。選ばずに離れると選ばれなかった側が失われていた不具合の修正（2026-08-07）
    this.version(6).stores({
      noteConflicts: 'id, termId, detectedAt',
    });
  }
}

export const db = new ItIndexDB();
