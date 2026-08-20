import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ItIndexDB } from '../db';
import { createSettingsRepository } from '../repositories/settings';
import { retryPendingPush, runAutoPush } from './pendingPush';

/**
 * 自動pushのwrite-ahead(#179)。「実行される予定のフラグが消える」=意図の破損という
 * 本人指定の方針に基づき、印の立ち方・消え方・再試行の入口を固定する。
 */
describe('pendingPush(#179)', () => {
  const dbs: ItIndexDB[] = [];
  afterEach(() => {
    for (const db of dbs) db.close();
    dbs.length = 0;
  });

  function repo() {
    const db = new ItIndexDB(`test-pendingPush-${Math.random()}`);
    dbs.push(db);
    return createSettingsRepository(db);
  }

  it('runAutoPush: 成功時は印を立ててから消す(push後にpush待ちが残らない)', async () => {
    const settingsRepo = repo();
    await settingsRepo.get(); // singleton行を作る
    const seen: (number | null)[] = [];
    const doPush = vi.fn(async () => {
      // push実行時点で印が既に立っている(write-ahead)ことを確認する
      seen.push((await settingsRepo.get()).pendingAutoPushAt);
    });

    const ok = await runAutoPush(settingsRepo, doPush);

    expect(ok).toBe(true);
    expect(seen[0]).not.toBeNull(); // pushの前に印が永続化されていた
    expect((await settingsRepo.get()).pendingAutoPushAt).toBeNull(); // 成功で消えた
  });

  it('runAutoPush: 失敗時は印が残る(次の契機で再試行される)', async () => {
    const settingsRepo = repo();
    await settingsRepo.get();

    const ok = await runAutoPush(settingsRepo, () => Promise.reject(new TypeError('Failed to fetch')));

    expect(ok).toBe(false);
    expect((await settingsRepo.get()).pendingAutoPushAt).not.toBeNull();
  });

  it('retryPendingPush: 印が残っている時だけrunを呼ぶ', async () => {
    const settingsRepo = repo();
    await settingsRepo.get();
    const run = vi.fn();

    await retryPendingPush(settingsRepo, run);
    expect(run).not.toHaveBeenCalled(); // 印なし → 呼ばない

    await settingsRepo.setPendingAutoPushAt(1000);
    await retryPendingPush(settingsRepo, run);
    expect(run).toHaveBeenCalledTimes(1); // 印あり → 呼ぶ
  });

  it('失敗→再試行成功の一連で印が消える(復旧シナリオ)', async () => {
    const settingsRepo = repo();
    await settingsRepo.get();

    await runAutoPush(settingsRepo, () => Promise.reject(new Error('オフライン')));
    expect((await settingsRepo.get()).pendingAutoPushAt).not.toBeNull();

    // オンライン復帰: retryPendingPushが再pushを起動し、成功して印が消える
    const run = vi.fn(() => void runAutoPush(settingsRepo, () => Promise.resolve()));
    await retryPendingPush(settingsRepo, run);
    expect(run).toHaveBeenCalled();
    await vi.waitFor(async () => expect((await settingsRepo.get()).pendingAutoPushAt).toBeNull());
  });
});
