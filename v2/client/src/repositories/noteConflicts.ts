import type { NoteConflict, NoteRecord } from '@it-index/shared';
import type { ItIndexDB } from '../db';
import type { NoteConflictRecord } from '../types';

// #157でsharedがNoteConflict型を公開するようになったため、以前ここにあった
// ReturnType<typeof mergeSnapshot>による構造的な再構成は不要になった。
// 既存のimport元を壊さないよう再exportする。
export type { NoteConflict };

/**
 * 競合レコードの操作(#157で再設計)。「open」= resolution===null && closedReason===null。
 * 論理競合1件=open行1件に正規化する——以前は毎pullで無条件addしていたため、
 * 同じ語の競合が同期のたびに別レコードとして積み上がっていた。
 */
export interface NoteConflictsRepository {
  /** 競合検出時(sync/syncEngine.ts)に1件保存する。保存済みレコードを返す */
  add(
    conflict: NoteConflict,
    peerDeviceId: string,
    detectedAt: number,
    syncEventId: string,
  ): Promise<NoteConflictRecord>;
  /** 新しい順(履歴タブの全件表示用)。open・解決済み・クローズ済みすべて含む */
  getAllOrdered(): Promise<NoteConflictRecord[]>;
  /** 未解決かつ未クローズ(照合フェーズとbaseline組み立ての対象) */
  getOpen(): Promise<NoteConflictRecord[]>;
  /** 同じ論理競合(同termId・同peer)のopen行を探す(再発時のrefresh対象の特定) */
  findOpenByTermAndPeer(termId: string, peerDeviceId: string): Promise<NoteConflictRecord | undefined>;
  /** 指定した同期イベントに紐づく行(SyncScreenの「直近の同期の競合」表示用) */
  getBySyncEventId(syncEventId: string): Promise<NoteConflictRecord[]>;
  /**
   * 再発した競合の更新(重複addの代わり)。スナップショットと検出時刻・同期イベントを
   * 差し替える。内容が前回と変わった場合はAI統合キャッシュ(merged)が古くなるため
   * resetMerged: trueで破棄する。
   */
  refresh(
    id: string,
    update: {
      local: NoteRecord;
      remote: NoteRecord;
      detectedAt: number;
      syncEventId: string;
      resetMerged: boolean;
    },
  ): Promise<void>;
  /**
   * 新データ未着のopen競合を最新の同期イベントへ持ち越す(#157)。
   * 字義どおり「再発しなければ消す」と、相手が同期していないだけの実競合を
   * 同期画面から失いPCで解消できなくなるため、新鮮なデータが届くまではリストに残す。
   */
  carryOver(id: string, syncEventId: string): Promise<void>;
  /** 自動クローズ(利用者の選択とは別軸)。'peer-decision'=PC側の決定を採用 / 'superseded'=競合が再発しなかった */
  closeAuto(id: string, reason: 'peer-decision' | 'superseded', at: number): Promise<void>;
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
    async add(conflict, peerDeviceId, detectedAt, syncEventId) {
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
        syncEventId,
        closedReason: null,
        closedAt: null,
      };
      await db.noteConflicts.add(record);
      return record;
    },

    async getAllOrdered() {
      const all = await db.noteConflicts.orderBy('detectedAt').toArray();
      return all.reverse();
    },

    async getOpen() {
      return db.noteConflicts.filter((c) => c.resolution === null && c.closedReason === null).toArray();
    },

    async findOpenByTermAndPeer(termId, peerDeviceId) {
      const open = await db.noteConflicts
        .where('termId')
        .equals(termId)
        .filter((c) => c.peerDeviceId === peerDeviceId && c.resolution === null && c.closedReason === null)
        .toArray();
      return open[0];
    },

    async getBySyncEventId(syncEventId) {
      return db.noteConflicts.where('syncEventId').equals(syncEventId).toArray();
    },

    async refresh(id, update) {
      await db.noteConflicts.update(id, {
        local: update.local,
        remote: update.remote,
        detectedAt: update.detectedAt,
        syncEventId: update.syncEventId,
        ...(update.resetMerged ? { merged: null } : {}),
      });
    },

    async carryOver(id, syncEventId) {
      await db.noteConflicts.update(id, { syncEventId });
    },

    async closeAuto(id, reason, at) {
      await db.noteConflicts.update(id, { closedReason: reason, closedAt: at });
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
