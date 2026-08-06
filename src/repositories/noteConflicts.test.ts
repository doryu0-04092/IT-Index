import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ItIndexDB } from '../db';
import { createNoteConflictsRepository } from './noteConflicts';

describe('NoteConflictsRepository', () => {
  let db: ItIndexDB;

  beforeEach(() => {
    db = new ItIndexDB(`test-note-conflicts-${crypto.randomUUID()}`);
  });

  afterEach(async () => {
    await db.delete();
  });

  const localNote = {
    termId: 'cors',
    body: 'この端末の説明',
    diagrams: [],
    updatedAt: 5,
    lastEditedBy: 'device-A',
    noteHistory: [],
  };
  const remoteNote = {
    termId: 'cors',
    body: '相手の説明',
    diagrams: [],
    updatedAt: 3,
    lastEditedBy: 'device-B',
    noteHistory: [],
  };

  it('add() persists the conflict as unresolved', async () => {
    const repo = createNoteConflictsRepository(db);

    const saved = await repo.add({ termId: 'cors', local: localNote, remote: remoteNote }, 'device-B', 10);

    expect(saved.resolution).toBeNull();
    expect(saved.merged).toBeNull();
    expect((await repo.getById(saved.id))?.local.body).toBe('この端末の説明');
    expect((await repo.getById(saved.id))?.remote.body).toBe('相手の説明');
  });

  it('getAllOrdered returns newest detectedAt first', async () => {
    const repo = createNoteConflictsRepository(db);
    await repo.add({ termId: 'cors', local: localNote, remote: remoteNote }, 'device-B', 10);
    await repo.add({ termId: 'udp', local: localNote, remote: remoteNote }, 'device-B', 20);

    const all = await repo.getAllOrdered();
    expect(all.map((c) => c.termId)).toEqual(['udp', 'cors']);
  });

  it('setResolution records the choice and resolvedAt', async () => {
    const repo = createNoteConflictsRepository(db);
    const saved = await repo.add({ termId: 'cors', local: localNote, remote: remoteNote }, 'device-B', 10);

    await repo.setResolution(saved.id, 'local', null, 30);

    const after = await repo.getById(saved.id);
    expect(after?.resolution).toBe('local');
    expect(after?.resolvedAt).toBe(30);
    expect(after?.merged).toBeNull();
  });

  it('setResolution caches the AI-merged content for later reuse', async () => {
    const repo = createNoteConflictsRepository(db);
    const saved = await repo.add({ termId: 'cors', local: localNote, remote: remoteNote }, 'device-B', 10);

    await repo.setResolution(saved.id, 'merged', { body: '統合した説明', diagrams: [] }, 30);
    const after = await repo.getById(saved.id);
    expect(after?.merged).toEqual({ body: '統合した説明', diagrams: [] });

    // 選び直した後も、一度キャッシュしたmergedは消えない（再度AIを呼ばず再利用するため）
    await repo.setResolution(saved.id, 'local', null, 40);
    const afterSwitch = await repo.getById(saved.id);
    expect(afterSwitch?.resolution).toBe('local');
    expect(afterSwitch?.merged).toEqual({ body: '統合した説明', diagrams: [] });
  });
});
