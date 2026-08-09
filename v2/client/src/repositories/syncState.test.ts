import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { ItIndexDB } from '../db';
import { createSyncStateRepository } from './syncState';

function makeDb(): ItIndexDB {
  return new ItIndexDB(`test-syncState-${Math.random()}`);
}

describe('createSyncStateRepository', () => {
  const dbs: ItIndexDB[] = [];
  afterEach(() => {
    for (const db of dbs) db.close();
    dbs.length = 0;
  });

  function repo() {
    const db = makeDb();
    dbs.push(db);
    return createSyncStateRepository(db);
  }

  it('未取り込み(初回)は0を返す', async () => {
    const r = repo();
    expect(await r.getCursor()).toBe(0);
  });

  it('setCursorで保存した値をgetCursorで読める', async () => {
    const r = repo();
    await r.setCursor(42);
    expect(await r.getCursor()).toBe(42);
  });

  it('setCursorは冪等(put)で複数回呼んでも1行のまま更新される', async () => {
    const r = repo();
    await r.setCursor(10);
    await r.setCursor(20);
    expect(await r.getCursor()).toBe(20);
  });
});
