import type { ItIndexDB } from '../db';
import type { KeyStoreRecord } from '../types';

export interface KeyStoreRepository {
  get(): Promise<KeyStoreRecord | undefined>;
  put(record: Omit<KeyStoreRecord, 'key'>): Promise<void>;
  clear(): Promise<void>;
}

export function createKeyStoreRepository(db: ItIndexDB): KeyStoreRepository {
  return {
    async get() {
      return db.keyStore.get('singleton');
    },

    async put(record) {
      await db.keyStore.put({ key: 'singleton', ...record });
    },

    async clear() {
      await db.keyStore.delete('singleton');
    },
  };
}
