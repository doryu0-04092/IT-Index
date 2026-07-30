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
});
