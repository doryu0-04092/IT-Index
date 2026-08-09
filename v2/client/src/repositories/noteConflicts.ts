import { mergeSnapshot } from '@it-index/shared';
import type { ItIndexDB } from '../db';
import type { NoteConflictRecord } from '../types';

/**
 * mergeSnapshot()の戻り値からconflicts要素の型だけを取り出す。NoteConflict型自体は
 * @it-index/sharedのexports("."のみ。src/index.tsのみが公開面)から公開されていないため、
 * 変更禁止のshared側を触らずに構造的な型として再利用する。
 */
export type NoteConflict = ReturnType<typeof mergeSnapshot>['conflicts'][number];

export interface NoteConflictsRepository {
  /** 競合検出時(sync/syncEngine.ts)に1件保存する。保存済みレコードを返す */
  add(conflict: NoteConflict, peerDeviceId: string, detectedAt: number): Promise<NoteConflictRecord>;
  /** 新しい順(SyncScreenの一覧表示用)。未解決・解決済み両方を含む */
  getAllOrdered(): Promise<NoteConflictRecord[]>;
  /** 未解決のみ(SyncScreenの解決UIの対象) */
  getUnresolved(): Promise<NoteConflictRecord[]>;
  /** どちらを採用するか選ぶ(v2はAI統合(merged)を実装しないため'local'|'remote'のみ) */
  setResolution(id: string, resolution: 'local' | 'remote', at: number): Promise<void>;
}

export function createNoteConflictsRepository(db: ItIndexDB): NoteConflictsRepository {
  return {
    async add(conflict, peerDeviceId, detectedAt) {
      const record: NoteConflictRecord = {
        id: crypto.randomUUID(),
        termId: conflict.termId,
        detectedAt,
        peerDeviceId,
        local: conflict.local,
        remote: conflict.remote,
        resolution: null,
        resolvedAt: null,
      };
      await db.noteConflicts.add(record);
      return record;
    },

    async getAllOrdered() {
      const all = await db.noteConflicts.orderBy('detectedAt').toArray();
      return all.reverse();
    },

    async getUnresolved() {
      return db.noteConflicts.filter((c) => c.resolution === null).toArray();
    },

    async setResolution(id, resolution, at) {
      await db.noteConflicts.update(id, { resolution, resolvedAt: at });
    },
  };
}
