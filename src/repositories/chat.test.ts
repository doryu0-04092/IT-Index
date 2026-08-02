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

  it('createSession initializes pendingExportedAt to null', async () => {
    const repo = createChatRepository(db);
    const session = await repo.createSession('cors');
    expect(session.pendingExportedAt).toBeNull();
  });

  it('markPendingExported records the export time', async () => {
    const repo = createChatRepository(db);
    const session = await repo.createSession('cors');

    await repo.markPendingExported(session.id, 12345);

    const [reloaded] = await repo.getOpenSessions();
    expect(reloaded.pendingExportedAt).toBe(12345);
  });

  it('getSession returns the session by id, or undefined if missing', async () => {
    const repo = createChatRepository(db);
    const session = await repo.createSession('cors');

    expect(await repo.getSession(session.id)).toMatchObject({ id: session.id, termId: 'cors' });
    expect(await repo.getSession('does-not-exist')).toBeUndefined();
  });
});
