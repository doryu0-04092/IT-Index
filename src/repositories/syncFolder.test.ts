import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ItIndexDB } from '../db';
import { createSyncFolderRepository } from './syncFolder';

// 実際の FileSystemDirectoryHandle は Node に存在しないため、構造化複製できる
// プレーンオブジェクトで代用する（保存・取得ができることの確認が目的）。
const fakeHandle = { name: 'IT-Index-sync', kind: 'directory' } as unknown as FileSystemDirectoryHandle;

describe('SyncFolderRepository', () => {
  let db: ItIndexDB;

  beforeEach(() => {
    db = new ItIndexDB(`test-syncfolder-${crypto.randomUUID()}`);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('returns undefined when nothing has been set', async () => {
    const repo = createSyncFolderRepository(db);
    expect(await repo.get()).toBeUndefined();
  });

  it('stores and retrieves the handle', async () => {
    const repo = createSyncFolderRepository(db);
    await repo.set(fakeHandle);

    const got = await repo.get();
    expect(got).toEqual(fakeHandle);
  });

  it('clear() removes the stored handle', async () => {
    const repo = createSyncFolderRepository(db);
    await repo.set(fakeHandle);
    await repo.clear();

    expect(await repo.get()).toBeUndefined();
  });
});
