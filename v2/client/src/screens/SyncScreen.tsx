import { useCallback, useEffect, useState } from 'react';
import type { AiClient } from '../ai/aiClient';
import type { ItIndexDB } from '../db';
import { ApiRequestError } from '../sync/apiClient';
import AuthForms from '../sync/AuthForms';
import KeyTransferSection from '../sync/KeyTransferSection';
import { runSync, type SyncEngineDeps, type SyncRunResult } from '../sync/syncEngine';
import { groupConflictsByTerm } from '../sync/groupConflicts';
import { runPendingBlobCleanup } from '../sync/syncKeyCleanup';
import { getAccountId } from '../sync/tokenStore';
import { useAuthState } from '../sync/useAuthState';
import { useConflictResolution } from '../sync/useConflictResolution';
import type { AsksRepository } from '../repositories/asks';
import type { NoteConflictRecord } from '../types';
import type { NoteConflictsRepository } from '../repositories/noteConflicts';
import type { NotesRepository } from '../repositories/notes';
import type { SyncEventsRepository } from '../repositories/syncEvents';
import type { SyncStateRepository } from '../repositories/syncState';
import type { TermsRepository } from '../repositories/terms';
import ConflictGroupItem from './ConflictGroupItem';
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
   * 同期が完了しデータが変わった可能性があるときの通知(#169)。App.tsxが
   * commitRefreshTickを上げ、開いたままの画面(検索・索引・単語詳細・履歴)へ
   * 裏側のデータ差し替えだけで自動反映する(取り込み完了(#167)と同じ仕組み)。
   */
  onSyncApplied?: () => void;
  /**
   * 競合の解消がnotesへ反映された直後の通知(#169)。App.tsxがリレーへの自動push
   * (Cloudflareのみ・AI API不要)に接続する。sync/useConflictResolution.tsのコメント参照。
   */
  onResolutionApplied?: () => void;
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
  onSyncApplied,
  onResolutionApplied,
  onGoToSettings,
}: SyncScreenProps) {
  const { auth, authError, authBusy, handleAuthSubmit, handleLogout } = useAuthState();

  // 同期の暗号鍵はアカウント単位で保管する(#182)。ログイン時にトークンと一緒に
  // localStorageへ書いてある(sync/tokenStore.ts)ため、認証状態が確定していれば読める
  const accountId = auth.status === 'authed' ? getAccountId() : null;

  const [syncBusy, setSyncBusy] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [lastResult, setLastResult] = useState<SyncRunResult | null>(null);

  const [conflicts, setConflicts] = useState<NoteConflictRecord[]>([]);
  const [resolvedConflicts, setResolvedConflicts] = useState<NoteConflictRecord[]>([]);

  // 未解決の競合は単語ごとにまとめて出す(#203。sync/groupConflicts.ts)
  const conflictGroups = groupConflictsByTerm(conflicts);

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
    onResolutionApplied,
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
    if (auth.status !== 'authed' || !deviceId || !accountId) return;
    const deps: SyncEngineDeps = {
      db,
      termsRepo,
      notesRepo,
      asksRepo,
      noteConflictsRepo,
      syncEventsRepo,
      syncStateRepo,
      deviceId,
      accountId,
      holdLocalOnConflict: isNativeApp,
    };

    setSyncBusy(true);
    setSyncError(null);
    try {
      // 鍵の受け取り後の後始末が終わっていなければ、同期の前にやり直す(sync/syncKeyCleanup.ts)。
      // 残したまま同期すると、孤児blobで相手端末のカーソルが止まったままになる
      await runPendingBlobCleanup(accountId, auth.token);

      const outcome = await runSync(deps, auth.token);
      setLastResult(outcome);
      setLastSyncedAt(Date.now());
      await loadConflicts();
      // 開いたままの他画面へ同期結果を自動反映する(#169)。受信0件でもpush側の状態
      // (取り込み待ち等)は変わらないため、受信か統一があった場合だけ通知する
      if (outcome.receivedBlobs > 0 || outcome.adoptedDecisions > 0) {
        onSyncApplied?.();
      }
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
          /* 利用者に出すのは「実際に何語変わったか」(#202)。blobの件数は端末が送る
             全量スナップショットの数で、中身が同じでも1件と数えるため意味を持たない */
          <p className="status-text" data-testid="sync-result">
            {lastResult.changedTerms > 0
              ? `${lastResult.changedTerms}語 変わりました`
              : '変わった内容はありませんでした'}
            {lastResult.conflictCount > 0 && `・競合${lastResult.conflictCount}件`}
            {lastResult.undecryptableBlobs > 0 && `・鍵が合わず読めなかった分${lastResult.undecryptableBlobs}件`}
            {lastResult.skippedBlobs > 0 && `・読めなかったデータ${lastResult.skippedBlobs}件`}
          </p>
        )}
        {syncError && <p className="sync-error">{syncError}</p>}
      </div>

      {/* 同期の鍵の受け渡し(#182)。暗号化した状態で預けるため、別端末で読むには同じ鍵が要る */}
      {accountId !== null && (
        <KeyTransferSection
          token={auth.token}
          accountId={accountId}
          undecryptableBlobs={lastResult?.undecryptableBlobs ?? 0}
          syncBusy={syncBusy}
          onSyncNow={() => void handleSyncNow()}
          // 鍵を受け取った側はサーバー上の古い差分を消すため、自分のカーソルも0へ戻す
          // (消した後に並ぶ新しい差分を読み直すため。KeyTransferSection.adoptKey参照)
          onKeyAdopted={async () => {
            await syncStateRepo.setCursor(0);
            setLastResult(null);
          }}
        />
      )}

      {/* Androidネイティブ(#165): 競合カード(両側の内容表示)は出さず、件数つきの案内文だけを
          差し込む。操作できないのに情報量が多い表示をやめ、「パソコン側で解消されるまで
          自分の内容を保持し、届いたら統一する」という役割どおりの見せ方にする(本人指定)。
          解消はPC側のみのため「解決済みの競合(選び直し)」一覧もAndroidでは出さない */}
      {isNativeApp ? (
        conflicts.length > 0 && (
          <div className="sync-conflicts">
            <p className="status-text conflict-pc-only-notice">
              競合が{conflicts.length}件あります。解消はパソコン側で行ってください。
              それまでこの端末では、この端末で保存した内容を表示します。
              パソコン側で解消すると、次の同期で同じ内容に統一されます。
            </p>
          </div>
        )
      ) : (
        <>
          {conflicts.length > 0 && (
            <div className="sync-conflicts">
              {/* 単語ごとにまとめて縦一列で出す(#203)。複数の端末で同じ単語に
                  AI検索を掛け続けると、その語の競合が端末の数だけ並ぶため */}
              <h3>未解決の競合({conflictGroups.length}語)</h3>
              <p className="status-text">
                いずれかを採用するか、AIで統合できます。何もしなければこの端末では新しい方(自動採用)のままです。
                解消するとスマートフォン側も次の同期で同じ内容に統一されます。
              </p>
              <ul className="sync-conflict-list">
                {conflictGroups.map((group) => (
                  <ConflictGroupItem
                    key={group.termId}
                    group={group}
                    canResolve
                    mergingId={mergingId}
                    mergeErrors={mergeErrors}
                    mergeErrorCodes={mergeErrorCodes}
                    onChooseLocal={chooseLocal}
                    onChooseRemote={chooseRemote}
                    onMerge={(c) => void merge(c)}
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
                    canResolve
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
        </>
      )}
    </section>
  );
}
