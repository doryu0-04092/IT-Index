import type { RawFile } from './sync';

/**
 * File System Access API を使った「共有フォルダ方式」（案3）。既にDropbox/OneDrive等の
 * 同期フォルダを持っている利用者が、そのフォルダをこのアプリの同期先として指定できるように
 * する。このAPIはPC版Chrome/Edgeのみ対応（Android Chromeは非対応。要件定義書§5.5参照）。
 *
 * ブラウザAPIを直接叩く層のためテスト対象外（src/keystore/webauthn.ts と同じ位置づけ）。
 *
 * TypeScriptの標準domライブラリには File System Access API の拡張部分
 * （showDirectoryPicker・permission系・非同期entries()）がまだ含まれていないため、
 * 最小限の型をここで補う（src/keystore/webauthn.ts のPRF拡張型と同じやり方）。
 */

type FsPermissionState = 'granted' | 'denied' | 'prompt';
type FsPermissionMode = { mode?: 'read' | 'readwrite' };

declare global {
  interface FileSystemDirectoryHandle {
    queryPermission(descriptor?: FsPermissionMode): Promise<FsPermissionState>;
    requestPermission(descriptor?: FsPermissionMode): Promise<FsPermissionState>;
    entries(): AsyncIterableIterator<[string, FileSystemDirectoryHandle | FileSystemFileHandle]>;
    getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>;
    getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FileSystemDirectoryHandle>;
    removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  }
  interface FileSystemFileHandle {
    createWritable(): Promise<FileSystemWritableFileStream>;
  }
  interface FileSystemWritableFileStream {
    write(data: string | BufferSource | Blob): Promise<void>;
    close(): Promise<void>;
  }
  interface Window {
    showDirectoryPicker(options?: FsPermissionMode): Promise<FileSystemDirectoryHandle>;
  }
}

export function isFolderSyncAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

export async function pickSyncFolder(): Promise<FileSystemDirectoryHandle> {
  if (!isFolderSyncAvailable()) {
    throw new Error('この環境では共有フォルダ方式は使えません（File System Access API非対応）');
  }
  return window.showDirectoryPicker({ mode: 'readwrite' });
}

/** 再訪時の権限確認。無許可なら再度リクエストする（ユーザー操作起点で呼ぶ必要がある） */
export async function ensureFolderPermission(dir: FileSystemDirectoryHandle): Promise<boolean> {
  const query = await dir.queryPermission({ mode: 'readwrite' });
  if (query === 'granted') return true;
  const request = await dir.requestPermission({ mode: 'readwrite' });
  return request === 'granted';
}

export async function readAllSyncFilesFromFolder(dir: FileSystemDirectoryHandle): Promise<RawFile[]> {
  const files: RawFile[] = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'file' || !name.startsWith('device-') || !name.endsWith('.json')) continue;
    const file = await handle.getFile();
    files.push({ name, content: await file.text() });
  }
  return files;
}

export async function writeSyncFileToFolder(dir: FileSystemDirectoryHandle, file: RawFile): Promise<void> {
  const handle = await dir.getFileHandle(file.name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(file.content);
  await writable.close();
}

/**
 * docs/local-data.md の実装。`data/terms.json` / `data/notes/*.md` / `AI_EDIT_GUIDE.md` /
 * `backups/` を扱うための追加関数群。上記の①〜②（共有フォルダ方式の輸送層）とは別に、
 * 本アプリのローカルデータ層（Claude Code が直接編集する対象）専用に用意する。
 */

/** サブディレクトリを取得する。無ければ作る */
export async function getOrCreateSubdirectory(dir: FileSystemDirectoryHandle, name: string): Promise<FileSystemDirectoryHandle> {
  return dir.getDirectoryHandle(name, { create: true });
}

/** ファイルのテキストを読む。存在しなければ undefined を返す（例外にしない） */
export async function readTextFile(dir: FileSystemDirectoryHandle, name: string): Promise<string | undefined> {
  try {
    const handle = await dir.getFileHandle(name);
    const file = await handle.getFile();
    return await file.text();
  } catch {
    return undefined;
  }
}

/** ファイルの最終更新時刻（epoch ms）を返す。存在しなければ undefined */
export async function readFileLastModified(dir: FileSystemDirectoryHandle, name: string): Promise<number | undefined> {
  try {
    const handle = await dir.getFileHandle(name);
    const file = await handle.getFile();
    return file.lastModified;
  } catch {
    return undefined;
  }
}

/** ファイルへテキストを書く。無ければ作る */
export async function writeTextFile(dir: FileSystemDirectoryHandle, name: string, content: string): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
}

export interface NamedFile {
  /** 拡張子を除いたファイル名（`.md` の場合は termId、`.json` の場合はそのまま） */
  name: string;
  content: string;
}

/** ディレクトリ直下の `*.md` を全件読む。`notes/` 用（`data/notes/<termId>.md`） */
export async function readMarkdownFilesFromFolder(dir: FileSystemDirectoryHandle): Promise<NamedFile[]> {
  const files: NamedFile[] = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'file' || !name.endsWith('.md')) continue;
    const file = await handle.getFile();
    files.push({ name: name.slice(0, -'.md'.length), content: await file.text() });
  }
  return files;
}
