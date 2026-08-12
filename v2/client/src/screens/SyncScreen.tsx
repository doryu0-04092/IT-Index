import { useCallback, useEffect, useRef, useState } from 'react';
import type { AiClient } from '../ai/aiClient';
import { resolveConflict } from '../ai/resolveConflict';
import type { ItIndexDB } from '../db';
import { ApiRequestError } from '../sync/apiClient';
import AuthForms from '../sync/AuthForms';
import { importV1Snapshot, pullFromRelay, pushToRelay, type SyncEngineDeps } from '../sync/syncEngine';
import { useAuthState } from '../sync/useAuthState';
import type { AsksRepository } from '../repositories/asks';
import type { NoteConflictRecord } from '../types';
import type { NoteConflictsRepository } from '../repositories/noteConflicts';
import type { NotesRepository } from '../repositories/notes';
import type { SyncStateRepository } from '../repositories/syncState';
import type { TermsRepository } from '../repositories/terms';
import ConflictItem from './ConflictItem';

export interface SyncScreenProps {
  db: ItIndexDB;
  /** シード取り込み・deviceId発行が終わるまでnull(useAppInit参照)。読み込み中は操作させない */
  deviceId: string | null;
  termsRepo: TermsRepository;
  notesRepo: NotesRepository;
  asksRepo: AsksRepository;
  noteConflictsRepo: NoteConflictsRepository;
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

interface SyncResultSummary {
  receivedBlobs: number;
  skippedBlobs: number;
  conflicts: number;
}

/**
 * 未ログイン時はサインアップ/ログインフォーム、ログイン済みならリレー同期の実行と
 * 競合解決、v1データ移行の入口をまとめる画面(要件定義書§4.2「サーバーリレー同期」)。
 *
 * 設定タブ新設(PR)に伴い、AI設定(BYOK)とテーマ切替はSettingsScreen.tsxへ移設し、
 * この画面はアカウント(ログイン/サインアップ)・同期実行・競合解決・v1取り込みに純化した。
 * 認証状態とログインフォームはsync/useAuthState.ts・sync/AuthForms.tsxへ切り出し、
 * SettingsScreen(ライセンスのログイン誘導)と共有する。
 */
export default function SyncScreen({
  db,
  deviceId,
  termsRepo,
  notesRepo,
  asksRepo,
  noteConflictsRepo,
  syncStateRepo,
  aiClient,
  onSyncNotify,
  onGoToSettings,
}: SyncScreenProps) {
  const { auth, authError, authBusy, handleAuthSubmit, handleLogout } = useAuthState();

  const [syncBusy, setSyncBusy] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [lastResult, setLastResult] = useState<SyncResultSummary | null>(null);

  const [conflicts, setConflicts] = useState<NoteConflictRecord[]>([]);
  const [resolvedConflicts, setResolvedConflicts] = useState<NoteConflictRecord[]>([]);
  // 「AIで統合する」の進行中・失敗は競合レコードごとに個別管理する(id -> 状態)。
  // 一覧の複数件を並行して統合しようとしても互いに干渉しないようにするため。
  const [mergingId, setMergingId] = useState<string | null>(null);
  const [mergeErrors, setMergeErrors] = useState<Record<string, string | null>>({});
  const [mergeErrorCodes, setMergeErrorCodes] = useState<Record<string, string | null>>({});

  const [importBusy, setImportBusy] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadConflicts = useCallback(async () => {
    setConflicts(await noteConflictsRepo.getUnresolved());
    setResolvedConflicts(await noteConflictsRepo.getResolved());
  }, [noteConflictsRepo]);

  useEffect(() => {
    if (auth.status === 'authed') {
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
    const deps: SyncEngineDeps = { db, termsRepo, notesRepo, asksRepo, noteConflictsRepo, syncStateRepo, deviceId };

    setSyncBusy(true);
    setSyncError(null);
    try {
      await pushToRelay(deps, auth.token);
      const outcome = await pullFromRelay(deps, auth.token);
      setLastResult(outcome);
      setLastSyncedAt(Date.now());
      await loadConflicts();
      // 完了/失敗をトースト通知する(依頼者指定。v1でToastを出していた「進行中/失敗」に
      // 相当する操作として同期の完了もここに含める。既存のインライン表示(lastResult等)は
      // そのまま残し、Toastは追加の通知として重ねる)。
      onSyncNotify?.(
        `同期しました(受信${outcome.receivedBlobs}件・競合${outcome.conflicts}件)。`,
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

  /**
   * 選択・選び直しの実処理(移植元: ../../../src/ui/shared/ConflictResolver.tsx apply())。
   * 「未解決の競合」「解決済みの競合」の両リストから同じ関数を使う——決着をつける操作は
   * どちらのリストで押しても同じ(notesへの反映・noteConflictsのresolution更新)ため。
   *
   * rejectedの決め方はv1と同じ: how==='remote'の時だけlocalを、それ以外(local/merged)は
   * remoteを「不採用側」としてnoteHistoryへ記録する(notesRepo.applyConflictResolution)。
   * mergedを選んだ場合にlocal自体は明示的には記録されないが、既存noteに既にlocal相当が
   * 入っていれば(次に反映)、そちらの記録(existing分)で兼ねられる——v1のまま踏襲した。
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
    // このDate.now()はrender中ではなくonClickハンドラ経由(handleChooseLocal等、コンポーネント
    // 直下の名前付き関数)から呼ばれる。以前は`.map()`内の無名クロージャから直接呼んでいたため
    // react-hooks/purityが誤検知していたが、関数を切り出したことで誤検知は起きなくなった。
    const at = Date.now();
    await notesRepo.applyConflictResolution(conflict.termId, chosen.body, chosen.diagrams, deviceId, at, rejected);
    await noteConflictsRepo.setResolution(conflict.id, how, mergedCache, at);
    await loadConflicts();
  }

  function handleChooseLocal(conflict: NoteConflictRecord) {
    void applyResolution(conflict, 'local', conflict.local, null);
  }

  function handleChooseRemote(conflict: NoteConflictRecord) {
    void applyResolution(conflict, 'remote', conflict.remote, null);
  }

  /**
   * 「AIで統合する」(要件定義書§5.5・移植元: ConflictResolver.tsx chooseMerged())。
   * 既にconflict.mergedへキャッシュがあれば、それを採用するだけでAIを再度呼ばない
   * ——同じ2案を何度統合しても同じ結果になるはずで、呼び出し回数(BYOK無しなら上限あり)を
   * 浪費させないため。
   */
  async function handleMerge(conflict: NoteConflictRecord) {
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

  async function handleImportV1File(file: File) {
    if (!deviceId) return;
    setImportBusy(true);
    setImportMessage(null);
    try {
      const text = await file.text();
      const deps: SyncEngineDeps = { db, termsRepo, notesRepo, asksRepo, noteConflictsRepo, syncStateRepo, deviceId };
      const result = await importV1Snapshot(deps, text);
      if (result.imported) {
        setImportMessage(`取り込みました(競合${result.conflicts}件)。`);
        await loadConflicts();
      } else {
        setImportMessage(`取り込みを中止しました: ${result.reason}`);
      }
    } catch (err) {
      setImportMessage(`取り込みに失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setImportBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
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
      <p>
        ログイン中: {auth.email} <button type="button" className="btn-secondary" onClick={handleLogoutAndReset}>ログアウト</button>
      </p>

      <div className="sync-actions">
        <button type="button" className="btn-primary" onClick={() => void handleSyncNow()} disabled={syncBusy || !deviceId}>
          {syncBusy ? '同期しています…' : '今すぐ同期'}
        </button>
        {lastSyncedAt && <p className="status-text">最終同期: {new Date(lastSyncedAt).toLocaleString('ja-JP')}</p>}
        {lastResult && (
          <p className="status-text">
            受信{lastResult.receivedBlobs}件(検証失敗{lastResult.skippedBlobs}件をスキップ)・競合{lastResult.conflicts}件
          </p>
        )}
        {syncError && <p className="sync-error">{syncError}</p>}
      </div>

      {conflicts.length > 0 && (
        <div className="sync-conflicts">
          <h3>未解決の競合({conflicts.length}件)</h3>
          <p className="status-text">
            どちらかを採用するか、2つをAIで統合できます。何もしなければ新しい方(自動採用)のままです。
          </p>
          <ul className="sync-conflict-list">
            {conflicts.map((c) => (
              <ConflictItem
                key={c.id}
                conflict={c}
                merging={mergingId === c.id}
                mergeError={mergeErrors[c.id] ?? null}
                mergeErrorCode={mergeErrorCodes[c.id] ?? null}
                onChooseLocal={() => handleChooseLocal(c)}
                onChooseRemote={() => handleChooseRemote(c)}
                onMerge={() => void handleMerge(c)}
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
                merging={mergingId === c.id}
                mergeError={mergeErrors[c.id] ?? null}
                mergeErrorCode={mergeErrorCodes[c.id] ?? null}
                onChooseLocal={() => handleChooseLocal(c)}
                onChooseRemote={() => handleChooseRemote(c)}
                onMerge={() => void handleMerge(c)}
                onGoToSettings={onGoToSettings}
              />
            ))}
          </ul>
        </div>
      )}

      <div className="sync-v1-import">
        <h3>v1のファイルを取り込む</h3>
        <label htmlFor="v1-import-input">v1の手動書き出しJSON</label>
        <input
          id="v1-import-input"
          ref={fileInputRef}
          type="file"
          accept="application/json"
          disabled={importBusy || !deviceId}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleImportV1File(file);
          }}
        />
        {importBusy && <p className="status-text">取り込んでいます…</p>}
        {importMessage && <p className="status-text">{importMessage}</p>}
      </div>
    </section>
  );
}
