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
  /** 解決済みのみ、新しい順(SyncScreenの「解決済み」一覧・選び直しの対象) */
  getResolved(): Promise<NoteConflictRecord[]>;
  /**
   * どちらを採用するか選ぶ、またはAI統合を選ぶ(v1 ../../../src/repositories/noteConflicts.ts
   * と同じ契約)。mergedは'merged'を選ぶ時だけ渡す——渡された場合のみ更新し、
   * local/remoteへの選び直しで既存のキャッシュを消さない(再度AI統合を選ぶ時の再利用のため)。
   */
  setResolution(
    id: string,
    resolution: 'local' | 'remote' | 'merged',
    merged: { body: string; diagrams: string[] } | null,
    at: number,
  ): Promise<void>;
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
        merged: null,
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

    async getResolved() {
      const all = await db.noteConflicts.filter((c) => c.resolution !== null).toArray();
      return all.sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0));
    },

    async setResolution(id, resolution, merged, at) {
      await db.noteConflicts.update(id, {
        resolution,
        // 既にキャッシュ済みのmergedを、local/remote選択時に消さない(v1と同じ理由。上記コメント参照)
        ...(merged ? { merged } : {}),
        resolvedAt: at,
      });
    },
  };
}
