import type { ItIndexDB } from '../db';
import type { SettingsRecord } from '../types';

export interface SettingsRepository {
  /** 無ければdeviceIdを新規発行して1行作る */
  get(): Promise<SettingsRecord>;
  setSeedVersion(version: string): Promise<void>;
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
        if (existing) return existing;

        const created: SettingsRecord = {
          key: 'singleton',
          deviceId: crypto.randomUUID(),
          seedVersion: null,
        };
        await db.settings.put(created);
        return created;
      });
    },

    async setSeedVersion(version) {
      await db.settings.update('singleton', { seedVersion: version });
    },
  };
}
