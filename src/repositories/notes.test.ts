import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ItIndexDB } from '../db';
import { createNotesRepository } from './notes';

describe('NotesRepository', () => {
  let db: ItIndexDB;

  beforeEach(() => {
    db = new ItIndexDB(`test-notes-${crypto.randomUUID()}`);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('applyCommit stacks the previous body into noteHistory', async () => {
    const repo = createNotesRepository(db);

    await repo.applyCommit('cors', '1版', [], 'device-A', 1);
    await repo.applyCommit('cors', '2版', [], 'device-A', 2);

    const note = await repo.getByTermId('cors');
    expect(note?.body).toBe('2版');
    expect(note?.noteHistory.map((h) => h.body)).toEqual(['1版']);
  });

  // 回帰: noteHistory は「この端末で上書きする前の版」の記録で、types.ts に「同期対象外」と
  // 明記してある。レコードごと put すると相手の履歴で置き換わり、この端末で積んだ版が消えて
  // ロールバックできなくなる。本文は同期しつつ、履歴はローカルのものを保つ。
  it('upsertFromSync updates the body but keeps the local noteHistory', async () => {
    const repo = createNotesRepository(db);

    await repo.applyCommit('cors', 'ローカル1版', [], 'device-A', 1);
    await repo.applyCommit('cors', 'ローカル2版', [], 'device-A', 2);

    await repo.upsertFromSync({
      termId: 'cors',
      body: '相手の本文',
      diagrams: [],
      updatedAt: 3,
      lastEditedBy: 'device-B',
      noteHistory: [], // 送信側が落として送る（src/sync/syncFile.ts の stripNoteHistory）
    });

    const note = await repo.getByTermId('cors');
    expect(note?.body).toBe('相手の本文'); // 本文は同期される
    expect(note?.noteHistory.map((h) => h.body)).toEqual(['ローカル1版']); // 履歴は残る
  });

  it('upsertFromSync works for a term that has no local note yet', async () => {
    const repo = createNotesRepository(db);

    await repo.upsertFromSync({
      termId: 'mtu',
      body: '相手の本文',
      diagrams: [],
      updatedAt: 1,
      lastEditedBy: 'device-B',
      noteHistory: [],
    });

    expect((await repo.getByTermId('mtu'))?.body).toBe('相手の本文');
  });
});
