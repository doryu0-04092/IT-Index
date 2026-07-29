import { FIELDS, type Field } from '../types';
import type { SyncFile } from './mergeSnapshot';

export type ParseSyncFileResult = { ok: true; file: SyncFile } | { ok: false; reason: string };

const KNOWN_SYNC_SCHEMA_VERSIONS = [1];

/**
 * docs/architecture.md §4.2「syncSchemaVersion 検証」。1つでも壊れていれば
 * そのファイルだけをスキップし、他の端末のファイルは読み続ける（呼び出し側の責務）。
 * ネットワーク越しに来る未信頼データなので、構造だけを検証する（内容の正しさまでは見ない）。
 */
export function parseSyncFile(raw: unknown): ParseSyncFileResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'ルート要素がオブジェクトではありません' };
  }
  const data = raw as Record<string, unknown>;

  if (typeof data.syncSchemaVersion !== 'number' || !KNOWN_SYNC_SCHEMA_VERSIONS.includes(data.syncSchemaVersion)) {
    return { ok: false, reason: `未知の syncSchemaVersion です: ${String(data.syncSchemaVersion)}` };
  }
  if (typeof data.deviceId !== 'string' || data.deviceId === '') {
    return { ok: false, reason: 'deviceId がありません' };
  }
  if (typeof data.writtenAt !== 'number') {
    return { ok: false, reason: 'writtenAt がありません' };
  }
  if (!Array.isArray(data.notes) || !data.notes.every(isValidNoteShape)) {
    return { ok: false, reason: 'notes の形式が不正です' };
  }
  if (!Array.isArray(data.asks) || !data.asks.every(isValidAskShape)) {
    return { ok: false, reason: 'asks の形式が不正です' };
  }
  if (!Array.isArray(data.aiTerms) || !data.aiTerms.every(isValidAiTermShape)) {
    return { ok: false, reason: 'aiTerms の形式が不正です' };
  }

  return {
    ok: true,
    file: {
      syncSchemaVersion: 1,
      deviceId: data.deviceId,
      writtenAt: data.writtenAt,
      notes: data.notes as SyncFile['notes'],
      asks: data.asks as SyncFile['asks'],
      aiTerms: data.aiTerms as SyncFile['aiTerms'],
    },
  };
}

function isValidNoteShape(x: unknown): boolean {
  if (typeof x !== 'object' || x === null) return false;
  const n = x as Record<string, unknown>;
  return (
    typeof n.termId === 'string' &&
    typeof n.body === 'string' &&
    Array.isArray(n.diagrams) &&
    n.diagrams.every((d) => typeof d === 'string') &&
    typeof n.updatedAt === 'number' &&
    typeof n.lastEditedBy === 'string' &&
    Array.isArray(n.noteHistory)
  );
}

function isValidAskShape(x: unknown): boolean {
  if (typeof x !== 'object' || x === null) return false;
  const a = x as Record<string, unknown>;
  return (
    typeof a.id === 'string' &&
    typeof a.termId === 'string' &&
    typeof a.sessionId === 'string' &&
    typeof a.at === 'number' &&
    typeof a.deviceId === 'string'
  );
}

function isValidAiTermShape(x: unknown): boolean {
  if (typeof x !== 'object' || x === null) return false;
  const t = x as Record<string, unknown>;
  return (
    typeof t.id === 'string' &&
    typeof t.term === 'string' &&
    Array.isArray(t.readings) &&
    t.readings.every((r) => typeof r === 'string') &&
    (t.summary === null || typeof t.summary === 'string') &&
    typeof t.field === 'string' &&
    (FIELDS as readonly string[]).includes(t.field as Field) &&
    Array.isArray(t.tags) &&
    t.origin === 'ai' && // 同期対象は origin:'ai' の語のみ（architecture.md §2 の例外規定）
    typeof t.createdAt === 'number' &&
    typeof t.updatedAt === 'number' &&
    (t.deletedAt === null || typeof t.deletedAt === 'number')
  );
}
