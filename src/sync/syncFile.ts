import type { SyncFile } from '../core/mergeSnapshot';
import { isSyncTarget } from '../core/syncTarget';
import type { AskRecord, NoteRecord, TermRecord } from '../types';

export function syncFileName(deviceId: string): string {
  return `device-${deviceId}.json`;
}

/**
 * 送信するノートから `noteHistory` を落とす。履歴は「この端末で上書きする前の版」の
 * 積み重ねで、ロールバック用の**端末ローカルな記録**（types.ts に「同期対象外」と明記）。
 * 相手へ送ると、受け取った側で自分の履歴が置き換わり、その端末で積んだ版が失われる。
 * 形式互換のため配列自体は残す（`validateSyncFile` が配列であることを要求するため）。
 */
export function stripNoteHistory(notes: NoteRecord[]): NoteRecord[] {
  return notes.map((n) => ({ ...n, noteHistory: [] }));
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
    notes: stripNoteHistory(allNotes.filter((n) => n.lastEditedBy === deviceId)),
    asks: allAsks.filter((a) => a.deviceId === deviceId),
    aiTerms: allTerms.filter(isSyncTarget),
  };
}
