import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { ItIndexDB } from '../db';
import { createSettingsRepository } from './settings';

function makeDb(): ItIndexDB {
  return new ItIndexDB(`test-settings-${Math.random()}`);
}

describe('createSettingsRepository', () => {
  const dbs: ItIndexDB[] = [];
  afterEach(() => {
    for (const db of dbs) db.close();
    dbs.length = 0;
  });

  function repo() {
    const db = makeDb();
    dbs.push(db);
    return createSettingsRepository(db);
  }

  it('初回get()はdeviceIdを新規発行する', async () => {
    const r = repo();
    const settings = await r.get();
    expect(settings.key).toBe('singleton');
    expect(settings.deviceId).toBeTruthy();
    expect(settings.seedVersion).toBeNull();
  });

  it('2回目以降のget()は同じdeviceIdを返す', async () => {
    const r = repo();
    const first = await r.get();
    const second = await r.get();
    expect(second.deviceId).toBe(first.deviceId);
  });

  it('同時に呼ばれても主キー衝突を起こさない(StrictModeの二重effect対策)', async () => {
    const r = repo();
    const [a, b] = await Promise.all([r.get(), r.get()]);
    expect(a.deviceId).toBe(b.deviceId);
  });

  it('setSeedVersionはseedVersionを更新する', async () => {
    const r = repo();
    await r.get();
    await r.setSeedVersion('2026-08-09');
    const settings = await r.get();
    expect(settings.seedVersion).toBe('2026-08-09');
  });
});
