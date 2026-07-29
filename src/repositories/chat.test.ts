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

  it('findStaleOpenSessions detects sessions idle past the timeout', async () => {
    const repo = createChatRepository(db);
    const session = await repo.createSession('tcp');
    await repo.touchSession(session.id, Date.now() - 20 * 60 * 1000); // 20分前

    const stale = await repo.findStaleOpenSessions(Date.now(), 15 * 60 * 1000);
    expect(stale.map((s) => s.id)).toContain(session.id);
  });

  it('commitSession is idempotent', async () => {
    const repo = createChatRepository(db);
    const session = await repo.createSession(null);

    await repo.commitSession(session.id);
    await repo.commitSession(session.id); // 2回目も例外を投げない

    const stale = await repo.findStaleOpenSessions(Date.now(), 0);
    expect(stale).toHaveLength(0);
  });
});
