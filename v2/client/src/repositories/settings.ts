import type { ItIndexDB } from '../db';
import type { SettingsRecord } from '../types';

export interface SettingsRepository {
  /** 無ければdeviceIdを新規発行して1行作る */
  get(): Promise<SettingsRecord>;
  setSeedVersion(version: string): Promise<void>;
  /**
   * 自動pushの「push待ち」印(#179。types.tsのpendingAutoPushAt参照)。
   * 時刻で立て、push成功時にnullで消す。呼び出し側がトランザクション内で呼べば
   * その書き込みに合流する(Dexieのネスト合流。settingsテーブルを対象に含めること)。
   */
  setPendingAutoPushAt(at: number | null): Promise<void>;
}

export function createSettingsRepository(db: ItIndexDB): SettingsRepository {
  return {
    async get() {
      // get→無ければadd、という非アトミックな手順だと、React StrictModeの二重effect実行等で
      // 同時に2回呼ばれた場合に両方が「無い」と判定し、2回目のadd()が主キー衝突エラーを起こす
      // (v1 ../../src/repositories/settings.ts参照)。1つのトランザクションに包み、
      // addではなくput(冪等)にすることで解決する。
      return db.transaction('rw', db.settings, async () => {
        const existing = await db.settings.get('singleton');
        // 旧レコード(#179より前)にはpendingAutoPushAtが無いためnullへ正規化する
        if (existing) return { ...existing, pendingAutoPushAt: existing.pendingAutoPushAt ?? null };

        const created: SettingsRecord = {
          key: 'singleton',
          deviceId: crypto.randomUUID(),
          seedVersion: null,
          autoUpdateExistingTerms: 'askedOnly',
          pendingAutoPushAt: null,
        };
        await db.settings.put(created);
        return created;
      });
    },

    async setSeedVersion(version) {
      await db.settings.update('singleton', { seedVersion: version });
    },

    async setPendingAutoPushAt(at) {
      await db.settings.update('singleton', { pendingAutoPushAt: at });
    },
  };
}
