import { useCallback, useEffect, useState } from 'react';
import type { AiClient } from '../ai/aiClient';
import type { ItIndexDB } from '../db';
import { ApiRequestError } from '../sync/apiClient';
import AuthForms from '../sync/AuthForms';
import { runSync, type SyncEngineDeps, type SyncRunResult } from '../sync/syncEngine';
import { useAuthState } from '../sync/useAuthState';
import { useConflictResolution } from '../sync/useConflictResolution';
import type { AsksRepository } from '../repositories/asks';
import type { NoteConflictRecord } from '../types';
import type { NoteConflictsRepository } from '../repositories/noteConflicts';
import type { NotesRepository } from '../repositories/notes';
import type { SyncEventsRepository } from '../repositories/syncEvents';
import type { SyncStateRepository } from '../repositories/syncState';
import type { TermsRepository } from '../repositories/terms';
import ConflictItem from './ConflictItem';

export interface SyncScreenProps {
  db: ItIndexDB;
  /** シード取り込み・deviceId発行が終わるまでnull(useAppInit参照)。読み込み中は操作させない */
  deviceId: string | null;
  /** Androidネイティブならtrue(#157)。競合はPC側で解消する方針のため、trueでは解消操作を出さない */
  isNativeApp: boolean;
  termsRepo: TermsRepository;
  notesRepo: NotesRepository;
  asksRepo: AsksRepository;
  noteConflictsRepo: NoteConflictsRepository;
  syncEventsRepo: SyncEventsRepository;
  syncStateRepo: SyncStateRepository;
  /** 「AIで統合する」(要件定義書§5.5)の呼び出しに使う。ChatScreenと同じAIプロキシ経路 */
  aiClient: AiClient;
  /** 同期成功・失敗をトースト通知するための呼び出し(依頼者指定。App.tsxのToastへ接続) */
  onSyncNotify?: (message: string, variant: 'error' | 'info') => void;
  /**
   * license_required時の設定タブ誘導(ChatScreen.tsx onGoToSettingsと同じ流儀)。未指定時は
   * ボタンを出さないだけで、通常経路(App.tsx)では必ず渡す。
   */
  onGoToSettings?: () => void;
}

/**
 * 未ログイン時はサインアップ/ログインフォーム、ログイン済みならリレー同期の実行と
 * 競合解決をまとめる画面(要件定義書§4.2「サーバーリレー同期」)。
 *
 * #157での変更点:
 * - 競合リストは「直近の同期(最新syncEvent)に紐づく競合」だけを表示する。次の同期で
 *   新鮮なデータが届き競合が再発しなければリストから消える(全履歴は履歴タブの競合一覧で見る)
 * - 解消操作はPC側のみ(isNativeApp=falseのとき)。Androidネイティブでは案内文言を出す
 * - 解消ロジックはsync/useConflictResolution.tsへ切り出し、履歴タブと共有する
 */
export default function SyncScreen({
  db,
  deviceId,
  isNativeApp,
  termsRepo,
  notesRepo,
  asksRepo,
  noteConflictsRepo,
  syncEventsRepo,
  syncStateRepo,
  aiClient,
  onSyncNotify,
  onGoToSettings,
}: SyncScreenProps) {
  const { auth, authError, authBusy, handleAuthSubmit, handleLogout } = useAuthState();

  const [syncBusy, setSyncBusy] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [lastResult, setLastResult] = useState<SyncRunResult | null>(null);

  const [conflicts, setConflicts] = useState<NoteConflictRecord[]>([]);
  const [resolvedConflicts, setResolvedConflicts] = useState<NoteConflictRecord[]>([]);

  const loadConflicts = useCallback(async () => {
    // 直近の同期に紐づく競合だけを出す(#157)。同期記録がまだ無ければ空
    const latest = await syncEventsRepo.getLatest();
    const linked = latest ? await noteConflictsRepo.getBySyncEventId(latest.id) : [];
    const active = linked.filter((c) => c.closedReason === null);
    setConflicts(active.filter((c) => c.resolution === null));
    setResolvedConflicts(
      active.filter((c) => c.resolution !== null).sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0)),
    );
  }, [noteConflictsRepo, syncEventsRepo]);

  const { mergingId, mergeErrors, mergeErrorCodes, chooseLocal, chooseRemote, merge } = useConflictResolution({
    deviceId,
    notesRepo,
    noteConflictsRepo,
    aiClient,
    onAfterResolve: loadConflicts,
  });

  useEffect(() => {
    // 認証確定時の競合一覧ロードは起動時副作用で、effectで行うのが正しい(useAppInit.tsの
    // 同名コメント参照)。loadConflictsはawait(getLatest)の後にしかsetStateを呼ばないが、
    // react-hooks/set-state-in-effectは間接呼び出しの先まで静的に検出するため、
    // このロードパターンに限り無効化する。
    if (auth.status === 'authed') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadConflicts();
    }
  }, [auth.status, loadConflicts]);

  function handleLogoutAndReset() {
    handleLogout();
    setLastResult(null);
    setLastSyncedAt(null);
    setConflicts([]);
    setResolvedConflicts([]);
  }

  async function handleSyncNow() {
    if (auth.status !== 'authed' || !deviceId) return;
    const deps: SyncEngineDeps = {
      db,
      termsRepo,
      notesRepo,
      asksRepo,
      noteConflictsRepo,
      syncEventsRepo,
      syncStateRepo,
      deviceId,
      holdLocalOnConflict: isNativeApp,
    };

    setSyncBusy(true);
    setSyncError(null);
    try {
      const outcome = await runSync(deps, auth.token);
      setLastResult(outcome);
      setLastSyncedAt(Date.now());
      await loadConflicts();
      // 完了/失敗をトースト通知する(依頼者指定)。統一(パソコン側の決定の取り込み)が
      // あった場合はその旨も知らせる——利用者から見て内容が変わる操作のため
      const unified = outcome.adoptedDecisions > 0 ? `・パソコン側の解消結果に${outcome.adoptedDecisions}件統一` : '';
      onSyncNotify?.(
        `同期しました(受信${outcome.receivedBlobs}件・競合${outcome.conflictCount}件${unified})。`,
        'info',
      );
    } catch (err) {
      // 公式ホストでライセンスが無い場合、サーバーは403 license_requiredを返す
      // (docs/v2/architecture.md §4)。新設計は不要で、既存のエラー表示経路に乗せる
      // (サーバーの日本語messageがそのまま表示される)。
      const message = err instanceof ApiRequestError ? err.message : '同期に失敗しました';
      setSyncError(message);
      onSyncNotify?.(message, 'error');
    } finally {
      setSyncBusy(false);
    }
  }

  if (auth.status === 'checking') {
    return <p className="status-text">同期の状態を確認しています…</p>;
  }

  if (auth.status === 'anonymous') {
    return <AuthForms busy={authBusy} error={authError} onSubmit={(mode, email, password) => void handleAuthSubmit(mode, email, password)} />;
  }

  return (
    <section className="sync-screen">
      <p className="sync-login-status">
        ログイン中: {auth.email} <button type="button" className="btn-secondary" onClick={handleLogoutAndReset}>ログアウト</button>
      </p>

      <div className="sync-actions">
        <button type="button" className="btn-primary" onClick={() => void handleSyncNow()} disabled={syncBusy || !deviceId}>
          {syncBusy ? '同期しています…' : '今すぐ同期'}
        </button>
        {lastSyncedAt && <p className="status-text">最終同期: {new Date(lastSyncedAt).toLocaleString('ja-JP')}</p>}
        {lastResult && (
          <p className="status-text">
            受信{lastResult.receivedBlobs}件(検証失敗{lastResult.skippedBlobs}件をスキップ)・競合{lastResult.conflictCount}件
          </p>
        )}
        {syncError && <p className="sync-error">{syncError}</p>}
      </div>

      {conflicts.length > 0 && (
        <div className="sync-conflicts">
          <h3>未解決の競合({conflicts.length}件)</h3>
          {isNativeApp ? (
            <p className="status-text">
              競合が見つかりました。競合の解消はパソコン側で行ってください。
            </p>
          ) : (
            <p className="status-text">
              どちらかを採用するか、2つをAIで統合できます。何もしなければこの端末では新しい方(自動採用)のままです。
              解消するとスマートフォン側も次の同期で同じ内容に統一されます。
            </p>
          )}
          <ul className="sync-conflict-list">
            {conflicts.map((c) => (
              <ConflictItem
                key={c.id}
                conflict={c}
                canResolve={!isNativeApp}
                merging={mergingId === c.id}
                mergeError={mergeErrors[c.id] ?? null}
                mergeErrorCode={mergeErrorCodes[c.id] ?? null}
                onChooseLocal={() => chooseLocal(c)}
                onChooseRemote={() => chooseRemote(c)}
                onMerge={() => void merge(c)}
                onGoToSettings={onGoToSettings}
              />
            ))}
          </ul>
        </div>
      )}

      {resolvedConflicts.length > 0 && (
        <div className="sync-conflicts sync-resolved-conflicts">
          <h3>解決済みの競合({resolvedConflicts.length}件)</h3>
          <p className="status-text">選び直しはいつでもできます。選び直すとこの端末のnotesが置き換わります。</p>
          <ul className="sync-conflict-list">
            {resolvedConflicts.map((c) => (
              <ConflictItem
                key={c.id}
                conflict={c}
                canResolve={!isNativeApp}
                merging={mergingId === c.id}
                mergeError={mergeErrors[c.id] ?? null}
                mergeErrorCode={mergeErrorCodes[c.id] ?? null}
                onChooseLocal={() => chooseLocal(c)}
                onChooseRemote={() => chooseRemote(c)}
                onMerge={() => void merge(c)}
                onGoToSettings={onGoToSettings}
              />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
