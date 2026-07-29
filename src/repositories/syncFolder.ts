import type { ItIndexDB } from '../db';

export interface SyncFolderRepository {
  get(): Promise<FileSystemDirectoryHandle | undefined>;
  set(handle: FileSystemDirectoryHandle): Promise<void>;
  clear(): Promise<void>;
}

export function createSyncFolderRepository(db: ItIndexDB): SyncFolderRepository {
  return {
    async get() {
      const record = await db.syncFolder.get('singleton');
      return record?.handle;
    },

    async set(handle) {
      await db.syncFolder.put({ key: 'singleton', handle });
    },

    async clear() {
      await db.syncFolder.delete('singleton');
    },
  };
}
