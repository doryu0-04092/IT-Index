import type { SettingsRepository } from '../repositories/settings';

/**
 * 自動push(#177/#169)のwrite-ahead実行(#179)。
 *
 * 「実行される予定のフラグが消える」のは意図の破損に当たる(本人指定の方針)ため、
 * pushを試みる**前**に「push待ち」を永続化し、成功が確認できた時だけ消す。
 * 失敗(オフライン・瞬断)やクラッシュではフラグが残り、再試行の契機
 * (アプリ起動時・オンライン復帰時・次の自動push時)で拾われる。
 *
 * doPushが未実行で終わるケース(未ログイン等)もフラグは残す——ログイン後の
 * 起動時リトライで拾えるようにするため。
 */
export async function runAutoPush(
  settingsRepo: SettingsRepository,
  doPush: () => Promise<unknown>,
): Promise<boolean> {
  await settingsRepo.setPendingAutoPushAt(Date.now());
  try {
    await doPush();
  } catch {
    // 失敗は静かに握りつぶす(フラグが残るので再試行される)。送るのは毎回全件の
    // スナップショットのため、いつ再試行しても同じ内容が届き、失われるものが無い
    return false;
  }
  await settingsRepo.setPendingAutoPushAt(null);
  return true;
}

/** push待ちが残っていればrunを呼ぶ(起動時・オンライン復帰時の再試行入口) */
export async function retryPendingPush(settingsRepo: SettingsRepository, run: () => void): Promise<void> {
  const settings = await settingsRepo.get();
  if (settings.pendingAutoPushAt !== null) {
    run();
  }
}
