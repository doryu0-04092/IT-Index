import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { ItIndexDB } from '../db';
import { createNotesRepository } from './notes';

function makeDb(): ItIndexDB {
  return new ItIndexDB(`test-notes-${Math.random()}`);
}

describe('createNotesRepository', () => {
  const dbs: ItIndexDB[] = [];
  afterEach(() => {
    for (const db of dbs) db.close();
    dbs.length = 0;
  });

  function repo() {
    const db = makeDb();
    dbs.push(db);
    return createNotesRepository(db);
  }

  it('新規保存はnoteHistoryが空になる', async () => {
    const r = repo();
    await r.saveBody('term-a', '本文1', 'device-1', 100);

    const note = await r.getByTermId('term-a');
    expect(note?.body).toBe('本文1');
    expect(note?.noteHistory).toEqual([]);
  });

  it('上書き保存すると旧内容がnoteHistoryへ退避される', async () => {
    const r = repo();
    await r.saveBody('term-a', '本文1', 'device-1', 100);
    await r.saveBody('term-a', '本文2', 'device-1', 200);

    const note = await r.getByTermId('term-a');
    expect(note?.body).toBe('本文2');
    expect(note?.noteHistory).toEqual([{ body: '本文1', diagrams: [], updatedAt: 100 }]);
  });

  it('getAllは全termIdのノートを返す', async () => {
    const r = repo();
    await r.saveBody('term-a', 'a', 'device-1', 100);
    await r.saveBody('term-b', 'b', 'device-1', 100);

    const all = await r.getAll();
    expect(all.map((n) => n.termId).sort()).toEqual(['term-a', 'term-b']);
  });

  it('upsertFromSyncはmergeSnapshot()の結果をそのまま書き、既存のnoteHistoryは保つ', async () => {
    const r = repo();
    await r.saveBody('term-a', '旧本文', 'device-1', 100);

    await r.upsertFromSync({
      termId: 'term-a',
      body: '相手の本文',
      diagrams: [],
      updatedAt: 200,
      lastEditedBy: 'device-2',
      resolvedAt: null,
      noteHistory: [], // 送信側はstripNoteHistoryで空配列にしてくる
    });

    const note = await r.getByTermId('term-a');
    expect(note?.body).toBe('相手の本文');
    expect(note?.lastEditedBy).toBe('device-2');
    // 相手のnoteHistory(空)で置き換わらず、こちらの履歴が保たれる
    expect(note?.noteHistory).toEqual([]);
  });

  it('upsertFromSyncは新規termIdでも書き込める', async () => {
    const r = repo();
    await r.upsertFromSync({
      termId: 'term-new',
      body: '本文',
      diagrams: [],
      updatedAt: 100,
      lastEditedBy: 'device-2',
      resolvedAt: null,
      noteHistory: [],
    });

    expect((await r.getByTermId('term-new'))?.body).toBe('本文');
  });

  it('applyConflictResolutionは選ばなかった側もnoteHistoryへ積む(再競合防止)', async () => {
    const r = repo();
    await r.saveBody('term-a', 'この端末の内容', 'device-1', 100);

    await r.applyConflictResolution(
      'term-a',
      '相手の内容',
      [],
      'device-1',
      200,
      { body: 'この端末の内容', diagrams: [] },
    );

    const note = await r.getByTermId('term-a');
    expect(note?.body).toBe('相手の内容');
    expect(note?.noteHistory).toEqual([{ body: 'この端末の内容', diagrams: [], updatedAt: 100 }]);
  });

  it('applyConflictResolutionは同じ内容を二重に積まない', async () => {
    const r = repo();
    await r.saveBody('term-a', 'A', 'device-1', 100);
    await r.applyConflictResolution('term-a', 'B', [], 'device-1', 200, { body: 'A', diagrams: [] });
    await r.applyConflictResolution('term-a', 'A', [], 'device-1', 300, { body: 'B', diagrams: [] });

    const note = await r.getByTermId('term-a');
    // A・Bの2種類のみ(往復しても増えない)
    expect(note?.noteHistory).toHaveLength(2);
  });

  it('applyCommitは新規termIdでもnoteHistoryを空で作れる(取り込みで初めて生まれる語)(#171)', async () => {
    const r = repo();

    await r.applyCommit('new-term', 'AIが起こした説明', ['graph TD;A-->B;'], 'device-1', 100);

    const note = await r.getByTermId('new-term');
    expect(note?.body).toBe('AIが起こした説明');
    expect(note?.diagrams).toEqual(['graph TD;A-->B;']);
    expect(note?.noteHistory).toEqual([]);
  });

  it('applyCommitは既存ノートがあれば旧内容をnoteHistoryへ退避する(#171)', async () => {
    const r = repo();
    await r.saveBody('term-a', '手入力した内容', 'device-1', 100);

    await r.applyCommit('term-a', 'AIが起こした説明', ['graph TD;A-->B;'], 'device-1', 200);

    const note = await r.getByTermId('term-a');
    expect(note?.body).toBe('AIが起こした説明');
    expect(note?.noteHistory).toEqual([{ body: '手入力した内容', diagrams: [], updatedAt: 100 }]);
  });

  // #171: adoptPeerDecision(相手側=PCの決定の採用。Androidネイティブの同期でのみ使う)
  describe('adoptPeerDecision', () => {
    const peerNote = (body: string, updatedAt: number) => ({
      termId: 'term-a',
      body,
      diagrams: [],
      updatedAt,
      lastEditedBy: 'device-pc',
      resolvedAt: null,
      noteHistory: [],
    });

    it('lastEditedBy・updatedAtを書き換えずに保存する(次の同期で再競合させないため)', async () => {
      const r = repo();
      await r.saveBody('term-a', 'この端末の内容', 'device-an', 100);

      await r.adoptPeerDecision(peerNote('PCの決定', 500));

      const note = await r.getByTermId('term-a');
      expect(note?.body).toBe('PCの決定');
      expect(note?.lastEditedBy).toBe('device-pc'); // この端末に書き換えない
      expect(note?.updatedAt).toBe(500);
    });

    it('保持していた自分の版をnoteHistoryへ退避する(採用で消える内容を残す)', async () => {
      const r = repo();
      await r.saveBody('term-a', 'この端末の内容', 'device-an', 100);

      await r.adoptPeerDecision(peerNote('PCの決定', 500));

      expect((await r.getByTermId('term-a'))?.noteHistory).toEqual([
        { body: 'この端末の内容', diagrams: [], updatedAt: 100 },
      ]);
    });

    it('同じ内容は履歴に二重で積まない', async () => {
      const r = repo();
      await r.saveBody('term-a', '同じ内容', 'device-an', 100);

      await r.adoptPeerDecision(peerNote('PCの決定', 500));
      await r.adoptPeerDecision(peerNote('同じ内容', 600)); // 履歴に既にある内容へ戻る
      await r.adoptPeerDecision(peerNote('PCの決定', 700));

      const history = (await r.getByTermId('term-a'))?.noteHistory ?? [];
      const bodies = history.map((h) => h.body);
      expect(new Set(bodies).size).toBe(bodies.length); // 重複なし
    });

    it('ローカルにノートが無い語でもupsertFromSync経路の履歴を壊さない(既存履歴の引き継ぎ)', async () => {
      const r = repo();
      // 既存ノートに履歴がある状態で、相手の決定を採用しても履歴は引き継がれる
      await r.saveBody('term-a', '版1', 'device-an', 100);
      await r.saveBody('term-a', '版2', 'device-an', 200);

      await r.adoptPeerDecision(peerNote('PCの決定', 500));

      const history = (await r.getByTermId('term-a'))?.noteHistory ?? [];
      expect(history.map((h) => h.body)).toEqual(['版1', '版2']);
    });

    it('ローカルにノートが無い語でも採用できる(相手だけが持っていた語)', async () => {
      const r = repo();

      await r.adoptPeerDecision(peerNote('PCの決定', 500));

      const note = await r.getByTermId('term-a');
      expect(note?.body).toBe('PCの決定');
      expect(note?.noteHistory).toEqual([]);
    });
  });
});
