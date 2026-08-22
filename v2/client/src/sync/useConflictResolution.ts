import { useState } from 'react';
import type { AiClient } from '../ai/aiClient';
import { resolveConflictAll } from '../ai/resolveConflict';
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
  /**
   * **1つの語について、この端末＋相手全部を1回のAI呼び出しで統一する(#238)。**
   *
   * 以前は相手ごとに2版ずつ統合していた。3台以上だと
   * (1)1回目の結果を2回目でもう一度AIに通すため**要約の要約で情報が薄まる**
   * (2)決定が複数回に分かれるため**相手端末が収束しない**
   * ——実機で「PC + Android2台で両方統合したら、どちらも採用中なのにAndroidの競合が
   * 解消されない」として報告された。
   *
   * **全部成功か、何もしないか。** AIが失敗したらノートも競合レコードも一切触らない。
   * 一部だけ解消されると、いまと同じ不整合になる。
   *
   * @param conflicts 同じ語の未解決の競合。**表示上の上限で畳まれた分も含め全件渡すこと**
   */
  async function mergeAll(conflicts: NoteConflictRecord[]) {
    if (!deviceId || conflicts.length === 0) return;
    const groupId = conflicts[0].termId;
    setMergeErrors((prev) => ({ ...prev, [groupId]: null }));
    setMergeErrorCodes((prev) => ({ ...prev, [groupId]: null }));
    setMergingId(groupId);

    try {
      // どの競合レコードの local も同じこの端末の内容。代表として最新の検出分を使う
      const representative = conflicts.reduce((newest, c) => (c.detectedAt > newest.detectedAt ? c : newest));

      /*
       * **同じ相手ぶんの統合結果が既にあるなら、AIを呼び直さない。**
       * 選び直し(一度「この端末の内容」にしてから統合へ戻す)のたびに課金するのは筋が悪い。
       * 対象全件が同じキャッシュを持つ時だけ使う——1件でも欠けていれば、その相手の情報が
       * 入っていない古い結果なので作り直す。
       */
      const cached = representative.merged;
      const allShareCache =
        cached !== null &&
        conflicts.every((c) => c.merged !== null && c.merged.body === cached.body);

      const result = allShareCache
        ? cached
        : await resolveConflictAll(
            representative.termId,
            representative.local,
            conflicts.map((c) => c.remote),
            aiClient,
          );
      if (!result) throw new Error('AIの応答を解釈できませんでした。');

      const at = Date.now();
      /*
       * ノートは1回だけ更新する。**相手から見て決定が1つになる**ことが要点で、
       * 複数回に分けると相手が収束しない。不採用側は全端末ぶんをnoteHistoryへ退避する。
       */
      for (const [i, conflict] of conflicts.entries()) {
        if (i === 0) {
          await notesRepo.applyConflictResolution(conflict.termId, result.body, result.diagrams, deviceId, at, {
            body: conflict.remote.body,
            diagrams: conflict.remote.diagrams,
          });
        } else {
          // 2件目以降は本文を書き換えず、退避だけ積む(同じ内容の再適用で履歴が伸びないよう
          // applyConflictResolution 側が重複を弾く)
          await notesRepo.applyConflictResolution(conflict.termId, result.body, result.diagrams, deviceId, at, {
            body: conflict.remote.body,
            diagrams: conflict.remote.diagrams,
          });
        }
        await noteConflictsRepo.setResolution(conflict.id, 'merged', result, at);
      }

      await onAfterResolve();
      onResolutionApplied?.();
    } catch (err) {
      setMergeErrors((prev) => ({
        ...prev,
        [groupId]: err instanceof ApiRequestError ? err.message : err instanceof Error ? err.message : String(err),
      }));
      setMergeErrorCodes((prev) => ({ ...prev, [groupId]: err instanceof ApiRequestError ? err.code : null }));
    } finally {
      setMergingId(null);
    }
  }

  return { mergingId, mergeErrors, mergeErrorCodes, chooseLocal, chooseRemote, mergeAll };
}
