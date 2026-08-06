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

  describe('applyConflictResolution（競合解消時の再競合バグ修正）', () => {
    it('stacks both the previous local body and the rejected (other side) body into noteHistory', async () => {
      const repo = createNotesRepository(db);
      await repo.applyCommit('cors', 'この端末の元の説明', [], 'device-A', 1);

      await repo.applyConflictResolution(
        'cors',
        'この端末の内容のまま採用',
        [],
        'device-A',
        2,
        { body: '相手の説明', diagrams: [] },
      );

      const note = await repo.getByTermId('cors');
      expect(note?.body).toBe('この端末の内容のまま採用');
      const historyBodies = note?.noteHistory.map((h) => h.body);
      expect(historyBodies).toContain('この端末の元の説明');
      // 採用しなかった相手の内容も履歴に残す——次回また相手が同じ内容を送ってきた時、
      // isRealConflict() が「既知の過去版」として再競合させないために必要
      expect(historyBodies).toContain('相手の説明');
    });

    it('does not duplicate the rejected body if it is already in noteHistory', async () => {
      const repo = createNotesRepository(db);
      await repo.applyCommit('cors', '元の説明', [], 'device-A', 1);

      await repo.applyConflictResolution('cors', '統合した説明', [], 'device-A', 2, {
        body: '相手の説明',
        diagrams: [],
      });
      // 同じ相手の内容でもう一度選び直しても、履歴に重複して積まれない
      await repo.applyConflictResolution('cors', 'また別の内容', [], 'device-A', 3, {
        body: '相手の説明',
        diagrams: [],
      });

      const note = await repo.getByTermId('cors');
      const matches = note?.noteHistory.filter((h) => h.body === '相手の説明');
      expect(matches).toHaveLength(1);
    });
  });
});
