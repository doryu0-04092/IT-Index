import type { SyncFile } from '../core/mergeSnapshot';
import type { AskRecord, NoteRecord, TermRecord } from '../types';

export function syncFileName(deviceId: string): string {
  return `device-${deviceId}.json`;
}

/**
 * この端末発の変更だけを書く（architecture.md §4.2「各ファイルには"その端末発の変更だけ"を書く」）。
 * 輸送手段（Drive経由か手動ファイルか）に依存しないため src/sync/ に置く。
 * notes/asks は lastEditedBy/deviceId で自分の分だけに絞る。
 *
 * aiTerms は例外: 「自分が作った語だけ」に絞りたいところだが、TermRecord には
 * 作成端末を追う createdBy 相当のフィールドが無いため、現状は既知の origin:'ai' を
 * 全件含めている（同期は id で和集合になるため重複しても壊れないが、ファイルは
 * 最適な差分にならない）。既知の制約として docs/drive-sync.md §5 に記録。
 */
export function buildOutboundSyncFile(
  deviceId: string,
  allNotes: NoteRecord[],
  allAsks: AskRecord[],
  allTerms: TermRecord[],
  now: number,
): SyncFile {
  return {
    syncSchemaVersion: 1,
    deviceId,
    writtenAt: now,
    notes: allNotes.filter((n) => n.lastEditedBy === deviceId),
    asks: allAsks.filter((a) => a.deviceId === deviceId),
    aiTerms: allTerms.filter((t) => t.origin === 'ai'),
  };
}
