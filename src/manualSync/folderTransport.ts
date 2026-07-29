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
