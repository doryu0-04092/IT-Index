import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ItIndexDB } from '../db';
import { createSettingsRepository } from './settings';

describe('SettingsRepository', () => {
  let db: ItIndexDB;

  beforeEach(() => {
    db = new ItIndexDB(`test-settings-${crypto.randomUUID()}`);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('creates a new row with a fresh deviceId on first call', async () => {
    const repo = createSettingsRepository(db);
    const settings = await repo.get();

    expect(settings.key).toBe('singleton');
    expect(settings.seedVersion).toBeNull();
    expect(settings.deviceId).toBeTruthy();
    expect(settings.autoUpdateExistingTerms).toBe('askedOnly'); // 既定は「利用者が尋ねた語だけ」
  });

  it('returns the same row on subsequent calls', async () => {
    const repo = createSettingsRepository(db);
    const first = await repo.get();
    const second = await repo.get();

    expect(second.deviceId).toBe(first.deviceId);
  });

  it('setSeedVersion updates the existing row', async () => {
    const repo = createSettingsRepository(db);
    await repo.get();
    await repo.setSeedVersion('2026-07-27');

    expect((await repo.get()).seedVersion).toBe('2026-07-27');
  });

  it('setAutoUpdateExistingTerms updates the existing row', async () => {
    const repo = createSettingsRepository(db);
    await repo.get();
    await repo.setAutoUpdateExistingTerms('all');

    expect((await repo.get()).autoUpdateExistingTerms).toBe('all');
  });

  it('setLocalTermsLastModified updates the existing row', async () => {
    const repo = createSettingsRepository(db);
    await repo.get();
    await repo.setLocalTermsLastModified(1_700_000_000_000);

    expect((await repo.get()).localTermsLastModified).toBe(1_700_000_000_000);
  });

  it('does not throw when get() is called concurrently on first access (regression)', async () => {
    // 実バグ: get→無ければadd という非アトミックな手順だと、React StrictModeの
    // 二重effect実行など同時に2回呼ばれた場合、両方が「無い」と判定して
    // 2回目の add() が主キー衝突で例外を投げていた（ブラウザでの実動作検証で発見）。
    const repo = createSettingsRepository(db);

    const [a, b] = await Promise.all([repo.get(), repo.get()]);

    expect(a.deviceId).toBe(b.deviceId); // 同じ行に収束している
    const all = await db.settings.toArray();
    expect(all).toHaveLength(1); // 重複行ができていない
  });
});
