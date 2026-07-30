import {
  getOrCreateSubdirectory,
  pickSyncFolder,
  readFileLastModified,
  readMarkdownFilesFromFolder,
  readTextFile,
  writeTextFile,
} from '../manualSync/folderTransport';
import type { NotesRepository } from '../repositories/notes';
import type { SettingsRepository } from '../repositories/settings';
import type { SyncFolderRepository } from '../repositories/syncFolder';
import type { TermsRepository } from '../repositories/terms';
import { buildAiEditGuideFile } from './editRules';
import { buildLocalDataExport } from './exportLocalData';
import { importLocalData, type ImportLocalDataResult } from './importLocalData';

/**
 * ローカルデータ層（docs/local-data.md）の取り込み・書き出し・初期化。
 * File System Access API を直接叩く層（src/manualSync/folderTransport.ts）と、
 * 純関数の変換・検証層（importLocalData.ts / exportLocalData.ts）を橋渡しする。
 * ここもDOM依存でテスト対象外——folderTransport.ts と同じ位置づけ。
 *
 * 呼び出し側（App.tsx / 設定UI）は、これらを呼ぶ前に `ensureFolderPermission()`
 * （src/manualSync/folderTransport.ts）で権限を確認しておくこと。
 */

const TERMS_FILE_NAME = 'terms.json';
const AI_GUIDE_FILE_NAME = 'AI_EDIT_GUIDE.md';
const DATA_DIR = 'data';
const NOTES_DIR = 'notes';
const BACKUPS_DIR = 'backups';

export interface LocalFolderDeps {
  termsRepo: TermsRepository;
  notesRepo: NotesRepository;
  settingsRepo: SettingsRepository;
  deviceId: string;
}

function todayVersion(): string {
  return new Date().toISOString().slice(0, 10);
}

function backupTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** 初回セットアップ。`data/`・`data/notes/`・`backups/`・`AI_EDIT_GUIDE.md` を無ければ作る */
export async function ensureLocalDataStructure(root: FileSystemDirectoryHandle): Promise<void> {
  const dataDir = await getOrCreateSubdirectory(root, DATA_DIR);
  await getOrCreateSubdirectory(dataDir, NOTES_DIR);
  await getOrCreateSubdirectory(root, BACKUPS_DIR);

  const existingTerms = await readTextFile(dataDir, TERMS_FILE_NAME);
  if (existingTerms === undefined) {
    await writeTextFile(
      dataDir,
      TERMS_FILE_NAME,
      JSON.stringify({ schemaVersion: 1, version: todayVersion(), terms: [] }, null, 2),
    );
  }

  await writeTextFile(root, AI_GUIDE_FILE_NAME, buildAiEditGuideFile());
}

/** 現在の `data/` の中身を `backups/<timestamp>/` へ複製する（取り込み・初期化の直前に必ず呼ぶ） */
async function backupCurrentData(root: FileSystemDirectoryHandle, dataDir: FileSystemDirectoryHandle): Promise<void> {
  const backupsDir = await getOrCreateSubdirectory(root, BACKUPS_DIR);
  const snapshotDir = await getOrCreateSubdirectory(backupsDir, backupTimestamp());

  const termsJson = await readTextFile(dataDir, TERMS_FILE_NAME);
  if (termsJson !== undefined) await writeTextFile(snapshotDir, TERMS_FILE_NAME, termsJson);

  const notesDir = await getOrCreateSubdirectory(dataDir, NOTES_DIR);
  const notesSnapshotDir = await getOrCreateSubdirectory(snapshotDir, NOTES_DIR);
  const notes = await readMarkdownFilesFromFolder(notesDir);
  for (const note of notes) {
    await writeTextFile(notesSnapshotDir, `${note.name}.md`, note.content);
  }
}

export interface LocalImportOutcome {
  /** false = `terms.json` の更新時刻が記録済みの値と変わっておらず、取り込みをスキップした */
  ran: boolean;
  result?: ImportLocalDataResult;
}

export interface SetupLocalFolderResult {
  dir: FileSystemDirectoryHandle;
  importOutcome: LocalImportOutcome;
}

/**
 * 初回セットアップの一連の流れ（フォルダ選択 → 構造生成 → 参照の登録 → 初回取り込み）を
 * 1つにまとめる。「ネイティブなフォルダ選択ダイアログを開く→そこで新規フォルダを作成・命名→
 * 選択する」の3手で完了する（ダイアログ自体を省略することはブラウザの仕様上できない。
 * docs/local-data.md §8）。`startIn` はダイアログの初期表示位置のヒント。
 *
 * ユーザーがダイアログを閉じた場合（`AbortError`）は、そのまま呼び出し元へ伝播する
 * ——呼び出し元は「キャンセルされた」として扱ってよい（例外を握りつぶさない）。
 */
export async function setupLocalFolder(
  syncFolderRepo: SyncFolderRepository,
  deps: LocalFolderDeps,
  startIn: 'desktop' | 'documents' | 'downloads' = 'documents',
): Promise<SetupLocalFolderResult> {
  const dir = await pickSyncFolder(startIn);
  await ensureLocalDataStructure(dir);
  await syncFolderRepo.set(dir);
  const importOutcome = await runLocalImportIfChanged(dir, deps);
  return { dir, importOutcome };
}

async function readLocalDataFiles(dataDir: FileSystemDirectoryHandle) {
  const termsJson = await readTextFile(dataDir, TERMS_FILE_NAME);
  const notesDir = await getOrCreateSubdirectory(dataDir, NOTES_DIR);
  const notes = await readMarkdownFilesFromFolder(notesDir);
  return { termsJson, notes: notes.map((n) => ({ termId: n.name, content: n.content })) };
}

/**
 * `data/terms.json` の更新時刻を記録済みの値と比較し、変化があれば取り込む。
 * 変化が無ければ何もしない（3510語規模の再パースを避ける。docs/local-data.md）。
 */
export async function runLocalImportIfChanged(
  root: FileSystemDirectoryHandle,
  deps: LocalFolderDeps,
): Promise<LocalImportOutcome> {
  const dataDir = await getOrCreateSubdirectory(root, DATA_DIR);
  const lastModified = await readFileLastModified(dataDir, TERMS_FILE_NAME);
  const settings = await deps.settingsRepo.get();

  if (lastModified !== undefined && lastModified === settings.localTermsLastModified) {
    return { ran: false };
  }

  await backupCurrentData(root, dataDir);
  const files = await readLocalDataFiles(dataDir);
  const result = await importLocalData(files, {
    termsRepo: deps.termsRepo,
    notesRepo: deps.notesRepo,
    deviceId: deps.deviceId,
  });
  await deps.settingsRepo.setLocalTermsLastModified(lastModified ?? null);
  return { ran: true, result };
}

/**
 * 確定ボタン押下時、AI要約処理より前に呼ぶ（docs/local-data.md「確定処理の順序」）。
 * Claude Code によるファイル編集が既定で優先されるのは、この関数が先に走り、
 * 未取り込みの編集を必ずDBへ反映してからAI要約処理が続くため。
 */
export const runLocalImportBeforeCommit = runLocalImportIfChanged;

/**
 * 確定ボタン押下時、AI要約処理の**後**に呼ぶ。IndexedDB の最新状態をファイルへ書き戻す。
 * 直前に runLocalImportBeforeCommit を必ず呼んでいる前提なので、`lastModified` の
 * 再照合は不要（Claude Code の編集は既に取り込み済みで、失われるものが無い）。
 */
export async function runLocalExport(root: FileSystemDirectoryHandle, deps: LocalFolderDeps): Promise<void> {
  const dataDir = await getOrCreateSubdirectory(root, DATA_DIR);
  const notesDir = await getOrCreateSubdirectory(dataDir, NOTES_DIR);

  const exportResult = await buildLocalDataExport(
    { termsRepo: deps.termsRepo, notesRepo: deps.notesRepo },
    todayVersion(),
  );
  await writeTextFile(dataDir, TERMS_FILE_NAME, exportResult.termsJson);
  for (const note of exportResult.notes) {
    await writeTextFile(notesDir, `${note.termId}.md`, note.content);
  }
  await writeTextFile(root, AI_GUIDE_FILE_NAME, buildAiEditGuideFile());

  const lastModified = await readFileLastModified(dataDir, TERMS_FILE_NAME);
  await deps.settingsRepo.setLocalTermsLastModified(lastModified ?? null);
}

/**
 * 初期データへのロールバック（設定画面の「初期データに戻す」）。
 * `origin:'ai'` の語を tombstone し、対応するノートを空にする。`backups/` へ退避してから行う。
 *
 * 既知の制限: `asks`（質問履歴）は削除しない。`AsksRepository` に削除手段が無く、
 * 対象語が消えても重み付け計算に実害が無い（履歴が単に使われなくなるだけ）ため、
 * この機能のために削除APIを新設するコストに見合わないと判断した。
 */
export async function resetToInitialData(root: FileSystemDirectoryHandle, deps: LocalFolderDeps): Promise<void> {
  const dataDir = await getOrCreateSubdirectory(root, DATA_DIR);
  await backupCurrentData(root, dataDir);

  const now = Date.now();
  const allTerms = await deps.termsRepo.getAll();
  const aiTerms = allTerms.filter((t) => t.origin === 'ai');
  for (const term of aiTerms) {
    await deps.termsRepo.upsertFromAi({ ...term, deletedAt: now, updatedAt: now });
    await deps.notesRepo.applyCommit(term.id, '', [], deps.deviceId, now);
  }

  await writeTextFile(
    dataDir,
    TERMS_FILE_NAME,
    JSON.stringify({ schemaVersion: 1, version: todayVersion(), terms: [] }, null, 2),
  );
  const notesDir = await getOrCreateSubdirectory(dataDir, NOTES_DIR);
  const existingNotes = await readMarkdownFilesFromFolder(notesDir);
  for (const note of existingNotes) {
    await notesDir.removeEntry(`${note.name}.md`);
  }

  const lastModified = await readFileLastModified(dataDir, TERMS_FILE_NAME);
  await deps.settingsRepo.setLocalTermsLastModified(lastModified ?? null);
}
