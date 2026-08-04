import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ItIndexDB } from '../db';
import { createChatRepository } from './chat';

describe('ChatRepository', () => {
  let db: ItIndexDB;

  beforeEach(() => {
    db = new ItIndexDB(`test-chat-${crypto.randomUUID()}`);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('commitSession is idempotent', async () => {
    const repo = createChatRepository(db);
    const session = await repo.createSession(null);

    await repo.commitSession(session.id);
    await repo.commitSession(session.id); // 2回目も例外を投げない

    const open = await repo.getOpenSessions();
    expect(open).toHaveLength(0);
  });

  it('getSession returns the session by id, or undefined if missing', async () => {
    const repo = createChatRepository(db);
    const session = await repo.createSession('cors');

    expect(await repo.getSession(session.id)).toMatchObject({ id: session.id, termId: 'cors' });
    expect(await repo.getSession('does-not-exist')).toBeUndefined();
  });

  // 回帰: 取り込み処理はAI呼び出しで数秒〜十数秒かかる。その間に同じ語のチャットを開くと
  // 同一セッションが再開されてしまい、あとから走り終えた取り込みがそれを committed にするため、
  // 追加した発言が黙って捨てられていた。取り込み中は再開・再取り込みの対象から外す。
  it('beginCommit takes the session out of the pending list and blocks a second commit', async () => {
    const repo = createChatRepository(db);
    const session = await repo.createSession('cors');

    expect(await repo.beginCommit(session.id)).toBe(true);
    expect(await repo.getOpenSessions()).toHaveLength(0);
    expect(await repo.findOpenSessionByTermId('cors')).toBeUndefined();
    // 2回目は取れない（「まとめて取り込む」と個別ボタンを続けて押した場合の二重実行を防ぐ）
    expect(await repo.beginCommit(session.id)).toBe(false);
  });

  it('abortCommit puts a failed commit back into the pending list', async () => {
    const repo = createChatRepository(db);
    const session = await repo.createSession('cors');

    await repo.beginCommit(session.id);
    await repo.abortCommit(session.id);

    expect(await repo.getOpenSessions()).toHaveLength(1);
    expect(await repo.beginCommit(session.id)).toBe(true); // 再試行できる
  });

  it('abortCommit does not resurrect an already committed session', async () => {
    const repo = createChatRepository(db);
    const session = await repo.createSession('cors');

    await repo.beginCommit(session.id);
    await repo.commitSession(session.id);
    await repo.abortCommit(session.id);

    expect(await repo.getOpenSessions()).toHaveLength(0);
  });
});
