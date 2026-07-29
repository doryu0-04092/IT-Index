import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ItIndexDB } from '../db';
import { createAsksRepository } from './asks';

describe('AsksRepository', () => {
  let db: ItIndexDB;

  beforeEach(() => {
    db = new ItIndexDB(`test-asks-${crypto.randomUUID()}`);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('addMany adds one record per term in a single call', async () => {
    const repo = createAsksRepository(db);
    await repo.addMany([
      { termId: 'tcp', sessionId: 's1', at: 1, deviceId: 'd1', source: 'ai' },
      { termId: 'udp', sessionId: 's1', at: 1, deviceId: 'd1', source: 'ai' },
    ]);

    const all = await repo.getAllOrdered();
    expect(all).toHaveLength(2);
    expect(new Set(all.map((a) => a.termId))).toEqual(new Set(['tcp', 'udp']));
  });

  it('addSearchConfirm adds a single source:search record with no sessionId', async () => {
    const repo = createAsksRepository(db);
    await repo.addSearchConfirm('tcp', 'd1', 1);

    const all = await repo.getAllOrdered();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ termId: 'tcp', deviceId: 'd1', at: 1, sessionId: null, source: 'search' });
  });

  it('upsertFromSync skips ids that already exist', async () => {
    const repo = createAsksRepository(db);
    await repo.addMany([{ termId: 'tcp', sessionId: 's1', at: 1, deviceId: 'd1', source: 'ai' }]);
    const [existing] = await repo.getAllOrdered();

    await repo.upsertFromSync([
      existing,
      { id: 'new-id', termId: 'udp', sessionId: 's2', at: 2, deviceId: 'd2', source: 'ai' },
    ]);

    const all = await repo.getAllOrdered();
    expect(all).toHaveLength(2);
  });
});
