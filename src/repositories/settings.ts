import type { ItIndexDB } from '../db';
import type { SettingsRecord } from '../types';

export interface SettingsRepository {
  /** 無ければ deviceId を新規発行して1行作る */
  get(): Promise<SettingsRecord>;
  setSeedVersion(version: string): Promise<void>;
}

export function createSettingsRepository(db: ItIndexDB): SettingsRepository {
  return {
    async get() {
      // get→無ければadd、という非アトミックな手順だと、同時に2回呼ばれた場合
      // （例: React StrictModeの二重effect実行、複数タブでの同時起動）に
      // 両方が「無い」と判定して add() が2回目で主キー衝突エラーを起こす。
      // 1つのトランザクションに包み、add ではなく put（冪等）にすることで解決する。
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
