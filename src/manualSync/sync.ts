import type { NoteConflict, SyncFile } from '../core/mergeSnapshot';
import { mergeSnapshot } from '../core/mergeSnapshot';
import { isSyncTarget } from '../core/syncTarget';
import { parseSyncFile } from '../core/validateSyncFile';
import { buildLocalSnapshot, type LocalSnapshotDeps } from '../sync/localSnapshot';
import { buildOutboundSyncFile, syncFileName } from '../sync/syncFile';

export interface RawFile {
  name: string;
  content: string;
}

export interface ImportResult {
  /** マージ後にローカルへ反映した notes の件数（自分の分・取り込んだ分どちらも含む） */
  mergedNoteCount: number;
  /** 決定的コードでは判断できず、AIによる統合案の提示が必要な語（要件定義書§5.5） */
  conflicts: NoteConflict[];
  /** JSON構文エラー・syncSchemaVersion検証NG等で読み飛ばしたファイル名 */
  skippedFiles: string[];
}

export interface ManualSyncDeps extends LocalSnapshotDeps {
  deviceId: string;
}

/**
 * Drive同期（src/drive/sync.ts）と同じ mergeSnapshot() を使うが、輸送手段が
 * 「利用者が手動で選んだファイル」である点だけが違う。一覧取得・自動アップロードは無い
 * ——取り込みとエクスポートは呼び出し側（UI）が別々のタイミングで明示的に行う。
 *
 * ファイルの読み込み（File API）はDOM依存のため src/manualSync/fileTransport.ts に分離し、
 * こちらはテキストを受け取るだけにしてある（テスト可能にするため）。
 */
export async function importSyncFiles(files: RawFile[], deps: ManualSyncDeps): Promise<ImportResult> {
  const remoteFiles: SyncFile[] = [];
  const skippedFiles: string[] = [];

  for (const file of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(file.content);
    } catch {
      skippedFiles.push(file.name);
      continue;
    }

    const parsed = parseSyncFile(raw);
    if (!parsed.ok) {
      skippedFiles.push(file.name);
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

  return { mergedNoteCount: result.notes.length, conflicts: result.conflicts, skippedFiles };
}

/**
 * この端末発の変更だけをエクスポート用に組み立てる。ダウンロード（ブラウザへの保存）は
 * fileTransport.ts が担当する。
 */
export async function exportOwnSyncFile(deps: ManualSyncDeps): Promise<RawFile> {
  const [allNotes, allAsks, allTerms] = await Promise.all([
    deps.notesRepo.getAll(),
    deps.asksRepo.getAllOrdered(),
    deps.termsRepo.getAll(),
  ]);
  const outbound = buildOutboundSyncFile(deps.deviceId, allNotes, allAsks, allTerms, Date.now());

  return { name: syncFileName(deps.deviceId), content: JSON.stringify(outbound, null, 2) };
}

/**
 * この端末が知っている**全部**（自分が編集した分だけでなく、他端末から取り込んで
 * 得た分も含む）をエクスポートする。共有フォルダ方式（PC限定）が使えない端末
 * （Androidなど）へ、PCが中継役として「知っている全部」をまとめて送り返す場面で使う
 * （docs/manual-sync.md §5「中継フロー」）。
 *
 * exportOwnSyncFile() との違いは notes/asks を deviceId で絞らない点のみ。
 * SyncFile 形式・検証（parseSyncFile）はそのまま使えるので、受け取り側は
 * 普通に importSyncFiles() でマージすればよい（上書きではない。理由は同docs参照）。
 */
export async function exportFullSnapshot(deps: ManualSyncDeps): Promise<RawFile> {
  const [allNotes, allAsks, allTerms] = await Promise.all([
    deps.notesRepo.getAll(),
    deps.asksRepo.getAllOrdered(),
    deps.termsRepo.getAllForSync(),
  ]);
  const full: SyncFile = {
    syncSchemaVersion: 1,
    deviceId: deps.deviceId,
    writtenAt: Date.now(),
    notes: allNotes,
    asks: allAsks,
    aiTerms: allTerms.filter(isSyncTarget),
  };

  return { name: `full-${syncFileName(deps.deviceId)}`, content: JSON.stringify(full, null, 2) };
}
