import type { NoteConflict, SyncFile } from '../core/mergeSnapshot';
import { mergeSnapshot } from '../core/mergeSnapshot';
import { parseSyncFile } from '../core/validateSyncFile';
import { buildLocalSnapshot, type LocalSnapshotDeps } from '../sync/localSnapshot';
import { buildOutboundSyncFile, syncFileName } from '../sync/syncFile';
import type { DriveFilesClient } from './driveApi';

export interface SyncResult {
  /** マージ後にローカルへ反映した notes の件数（自分の分・他端末の分どちらも含む） */
  mergedNoteCount: number;
  /** 決定的コードでは判断できず、AIによる統合案の提示が必要な語（要件定義書§5.5） */
  conflicts: NoteConflict[];
  /** syncSchemaVersion 検証等に落ちて読み飛ばしたファイル名 */
  skippedFiles: string[];
}

export interface SyncDeps extends LocalSnapshotDeps {
  deviceId: string;
  driveFiles: DriveFilesClient;
}

/**
 * docs/architecture.md §4.2 のシーケンス図をそのまま実装する。
 * 1. 全端末の device-*.json を取得（検証NGはスキップして他は続行）
 * 2. mergeSnapshot() で決定的マージ
 * 3. 結果をローカルへ反映
 * 4. 自分のファイルだけを上書きする
 *
 * AIによる競合解決（conflicts）はここでは適用しない。決定的マージの結果（newest-wins）は
 * 常に適用されるため、鍵が無くても同期は完結する（要件定義書§5.5「AIは同期の必須要素にしない」）。
 * AI提案の適用は src/sync/resolveConflict.ts 経由で別途、承認を挟んで行う。
 */
export async function runSync(deps: SyncDeps): Promise<SyncResult> {
  const files = await deps.driveFiles.list();
  const deviceFiles = files.filter((f) => f.name.startsWith('device-') && f.name.endsWith('.json'));

  const remoteFiles: SyncFile[] = [];
  const skippedFiles: string[] = [];

  for (const meta of deviceFiles) {
    const content = await deps.driveFiles.download(meta.id);
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      skippedFiles.push(meta.name);
      continue;
    }

    const parsed = parseSyncFile(raw);
    if (!parsed.ok) {
      skippedFiles.push(meta.name);
      continue;
    }
    remoteFiles.push(parsed.file);
  }

  const local = await buildLocalSnapshot(deps);
  const result = mergeSnapshot(local, remoteFiles);

  for (const note of result.notes) {
    await deps.notesRepo.upsertFromSync(note);
  }
  await deps.asksRepo.upsertFromSync(result.asks);
  for (const term of result.terms) {
    await deps.termsRepo.upsertFromSync(term);
  }

  // 自分のファイルだけを書く。マージ後の最新状態から改めて組み立てる
  // （他端末の更新が自分の note を上書きした場合、それはもう自分の分ではなくなるため）
  const [allNotes, allAsks, allTerms] = await Promise.all([
    deps.notesRepo.getAll(),
    deps.asksRepo.getAllOrdered(),
    deps.termsRepo.getAll(),
  ]);
  const outbound = buildOutboundSyncFile(deps.deviceId, allNotes, allAsks, allTerms, Date.now());

  const ownFileName = syncFileName(deps.deviceId);
  const existing = deviceFiles.find((f) => f.name === ownFileName);
  await deps.driveFiles.upsert(ownFileName, JSON.stringify(outbound), existing?.id);

  return { mergedNoteCount: result.notes.length, conflicts: result.conflicts, skippedFiles };
}
