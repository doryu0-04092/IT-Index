import { useState } from 'react';
import type { AiClient } from '../ai/aiClient';
import { resolveConflict } from '../ai/resolveConflict';
import { ApiRequestError } from './apiClient';
import type { NoteConflictRecord } from '../types';
import type { NoteConflictsRepository } from '../repositories/noteConflicts';
import type { NotesRepository } from '../repositories/notes';

/**
 * 競合の選択・選び直し・AI統合のロジック(#157でSyncScreenから切り出し)。
 * 同期タブ(SyncScreen)と履歴タブの競合一覧(HistoryScreen)の両方から使う——
 * 決着をつける操作はどちらの画面で押しても同じ(notesへの反映・noteConflictsの
 * resolution更新)ため、二重実装を作らない。
 *
 * 「AIで統合する」の進行中・失敗は競合レコードごとに個別管理する(id -> 状態)。
 * 一覧の複数件を並行して統合しようとしても互いに干渉しないようにするため。
 */
export function useConflictResolution({
  deviceId,
  notesRepo,
  noteConflictsRepo,
  aiClient,
  onAfterResolve,
  onResolutionApplied,
}: {
  deviceId: string | null;
  notesRepo: NotesRepository;
  noteConflictsRepo: NoteConflictsRepository;
  aiClient: AiClient;
  /** 反映後の一覧再読込(呼び出し画面が自分のリストを読み直す) */
  onAfterResolve: () => Promise<void>;
  /**
   * 解消がnotesへ反映された直後の通知(#169依頼者指定)。App.tsxがリレーへの自動push
   * (AI APIとは無関係、Cloudflareのリレーのみ)に接続する——解消した瞬間に決定を
   * リレーへ移しておけば、相手端末がその時オフラインでも次の同期で取り込める。
   * 手動の「今すぐ同期」を忘れると決定が届かない穴を塞ぐ。
   */
  onResolutionApplied?: () => void;
}) {
  const [mergingId, setMergingId] = useState<string | null>(null);
  const [mergeErrors, setMergeErrors] = useState<Record<string, string | null>>({});
  const [mergeErrorCodes, setMergeErrorCodes] = useState<Record<string, string | null>>({});

  /**
   * 選択・選び直しの実処理(移植元: ../../../src/ui/shared/ConflictResolver.tsx apply())。
   * rejectedの決め方はv1と同じ: how==='remote'の時だけlocalを、それ以外(local/merged)は
   * remoteを「不採用側」としてnoteHistoryへ記録する(notesRepo.applyConflictResolution)。
   */
  async function applyResolution(
    conflict: NoteConflictRecord,
    how: 'local' | 'remote' | 'merged',
    chosen: { body: string; diagrams: string[] },
    mergedCache: { body: string; diagrams: string[] } | null,
  ) {
    if (!deviceId) return;
    const rejected =
      how === 'remote'
        ? { body: conflict.local.body, diagrams: conflict.local.diagrams }
        : { body: conflict.remote.body, diagrams: conflict.remote.diagrams };
    const at = Date.now();
    await notesRepo.applyConflictResolution(conflict.termId, chosen.body, chosen.diagrams, deviceId, at, rejected);
    await noteConflictsRepo.setResolution(conflict.id, how, mergedCache, at);
    await onAfterResolve();
    onResolutionApplied?.();
  }

  function chooseLocal(conflict: NoteConflictRecord) {
    void applyResolution(conflict, 'local', conflict.local, null);
  }

  function chooseRemote(conflict: NoteConflictRecord) {
    void applyResolution(conflict, 'remote', conflict.remote, null);
  }

  /**
   * 「AIで統合する」(要件定義書§5.5)。既にconflict.mergedへキャッシュがあれば、
   * それを採用するだけでAIを再度呼ばない——同じ2案を何度統合しても同じ結果になるはずで、
   * 呼び出し回数(BYOK無しなら上限あり)を浪費させないため。
   */
  async function merge(conflict: NoteConflictRecord) {
    setMergeErrors((prev) => ({ ...prev, [conflict.id]: null }));
    setMergeErrorCodes((prev) => ({ ...prev, [conflict.id]: null }));
    if (conflict.merged) {
      await applyResolution(conflict, 'merged', conflict.merged, conflict.merged);
      return;
    }
    setMergingId(conflict.id);
    try {
      const result = await resolveConflict(conflict.termId, conflict.local, conflict.remote, aiClient);
      if (!result) throw new Error('AIの応答を解釈できませんでした。');
      await applyResolution(conflict, 'merged', result, result);
    } catch (err) {
      setMergeErrors((prev) => ({
        ...prev,
        [conflict.id]: err instanceof ApiRequestError ? err.message : err instanceof Error ? err.message : String(err),
      }));
      setMergeErrorCodes((prev) => ({ ...prev, [conflict.id]: err instanceof ApiRequestError ? err.code : null }));
    } finally {
      setMergingId(null);
    }
  }

  return { mergingId, mergeErrors, mergeErrorCodes, chooseLocal, chooseRemote, merge };
}
