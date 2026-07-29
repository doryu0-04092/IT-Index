import type { DriveFileMeta, DriveFilesClient } from './driveApi';

/** テスト専用のフェイク appDataFolder。本番コードからは import しない想定。 */
export function createFakeDriveFilesClient(initialFiles: Record<string, string> = {}): DriveFilesClient & {
  filesByName: () => Record<string, string>;
} {
  const files = new Map<string, { id: string; content: string }>();
  let nextId = 1;
  for (const [name, content] of Object.entries(initialFiles)) {
    files.set(name, { id: `file-${nextId++}`, content });
  }

  return {
    async list(): Promise<DriveFileMeta[]> {
      return [...files.entries()].map(([name, f]) => ({ id: f.id, name }));
    },

    async download(fileId) {
      const entry = [...files.values()].find((f) => f.id === fileId);
      if (!entry) throw new Error(`file not found: ${fileId}`);
      return entry.content;
    },

    async upsert(fileName, content, existingFileId) {
      if (existingFileId) {
        const entry = [...files.entries()].find(([, f]) => f.id === existingFileId);
        if (!entry) throw new Error(`file not found: ${existingFileId}`);
        files.set(entry[0], { id: existingFileId, content });
        return;
      }
      files.set(fileName, { id: `file-${nextId++}`, content });
    },

    filesByName() {
      return Object.fromEntries([...files.entries()].map(([name, f]) => [name, f.content]));
    },
  };
}
