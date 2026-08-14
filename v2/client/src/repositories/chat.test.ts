import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { ItIndexDB } from '../db';
import { createChatRepository } from './chat';

function makeDb(): ItIndexDB {
  return new ItIndexDB(`test-chatrepo-${Math.random()}`);
}

describe('createChatRepository', () => {
  const dbs: ItIndexDB[] = [];
  afterEach(async () => {
    for (const db of dbs) await db.delete();
    dbs.length = 0;
  });

  function repo() {
    const db = makeDb();
    dbs.push(db);
    return createChatRepository(db);
  }

  it('createSessionはtermId:nullとsubjectLabelを持つセッションを作れる(AIで検索)', async () => {
    const chatRepo = repo();
    const session = await chatRepo.createSession(null, '知らない語');
    expect(session.termId).toBeNull();
    expect(session.subjectLabel).toBe('知らない語');
    expect(session.status).toBe('open');
  });

  it('beginCommitはopen→committingへ遷移させ、二重取り込みを防ぐ', async () => {
    const chatRepo = repo();
    const session = await chatRepo.createSession(null);

    const first = await chatRepo.beginCommit(session.id);
    const second = await chatRepo.beginCommit(session.id);

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('abortCommitはcommitting→openへ戻す(再試行できる状態にする)', async () => {
    const chatRepo = repo();
    const session = await chatRepo.createSession(null);
    await chatRepo.beginCommit(session.id);

    await chatRepo.abortCommit(session.id);

    const open = await chatRepo.getOpenSessions();
    expect(open.map((s) => s.id)).toContain(session.id);
  });

  it('declineSessionはopen→declinedへ遷移し、会話は削除しない', async () => {
    const chatRepo = repo();
    const session = await chatRepo.createSession(null);
    await chatRepo.appendMessage(session.id, 'user', 'こんにちは');

    await chatRepo.declineSession(session.id);

    const stored = await chatRepo.getSession(session.id);
    expect(stored?.status).toBe('declined');
    expect(await chatRepo.getMessages(session.id)).toHaveLength(1);
  });

  it('committingは再開・取り込みの対象から外れる(getOpenSessions/findOpenSessionByTermIdに出ない)', async () => {
    const chatRepo = repo();
    const session = await chatRepo.createSession('tcp-ip');
    await chatRepo.beginCommit(session.id);

    expect(await chatRepo.findOpenSessionByTermId('tcp-ip')).toBeUndefined();
    const open = await chatRepo.getOpenSessions();
    expect(open.map((s) => s.id)).not.toContain(session.id);
  });

  it('findOpenSessionBySubjectLabelは同じ検索語のopenセッションを見つける', async () => {
    const chatRepo = repo();
    const session = await chatRepo.createSession(null, 'ゼロトラスト');

    const found = await chatRepo.findOpenSessionBySubjectLabel('ゼロトラスト');
    expect(found?.id).toBe(session.id);
  });

  describe('deleteEmptyOpenSessions(起動時クリーンアップ。本人指定)', () => {
    it('open×メッセージ0件のセッションだけを削除し、メッセージがあるopenセッションは残す', async () => {
      const chatRepo = repo();
      const empty = await chatRepo.createSession(null, '開いてすぐ戻った語');
      const touched = await chatRepo.createSession(null, 'ゼロトラスト');
      await chatRepo.appendMessage(touched.id, 'user', 'ゼロトラストとは？');

      await chatRepo.deleteEmptyOpenSessions();

      expect(await chatRepo.getSession(empty.id)).toBeUndefined();
      expect(await chatRepo.getSession(touched.id)).toBeDefined();
    });

    it('committing/committed/declinedのセッションは(メッセージ0件でも)削除しない', async () => {
      const chatRepo = repo();
      const committing = await chatRepo.createSession(null, '取り込み中');
      await chatRepo.beginCommit(committing.id);

      const declined = await chatRepo.createSession(null, '登録しない選択済み');
      await chatRepo.declineSession(declined.id);

      await chatRepo.deleteEmptyOpenSessions();

      expect(await chatRepo.getSession(committing.id)).toBeDefined();
      expect(await chatRepo.getSession(declined.id)).toBeDefined();
    });
  });
});
