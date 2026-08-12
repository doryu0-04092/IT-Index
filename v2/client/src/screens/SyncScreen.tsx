import { useCallback, useEffect, useRef, useState } from 'react';
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

export interface SyncScreenProps {
  db: ItIndexDB;
  /** シード取り込み・deviceId発行が終わるまでnull(useAppInit参照)。読み込み中は操作させない */
  deviceId: string | null;
  termsRepo: TermsRepository;
  notesRepo: NotesRepository;
  asksRepo: AsksRepository;
  noteConflictsRepo: NoteConflictsRepository;
  syncStateRepo: SyncStateRepository;
  /** 同期成功・失敗をトースト通知するための呼び出し(依頼者指定。App.tsxのToastへ接続) */
  onSyncNotify?: (message: string, variant: 'error' | 'info') => void;
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
  onSyncNotify,
}: SyncScreenProps) {
  const { auth, authError, authBusy, handleAuthSubmit, handleLogout } = useAuthState();

  const [syncBusy, setSyncBusy] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [lastResult, setLastResult] = useState<SyncResultSummary | null>(null);

  const [conflicts, setConflicts] = useState<NoteConflictRecord[]>([]);

  const [importBusy, setImportBusy] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadConflicts = useCallback(async () => {
    setConflicts(await noteConflictsRepo.getUnresolved());
  }, [noteConflictsRepo]);

  useEffect(() => {
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

  async function handleResolve(conflict: NoteConflictRecord, side: 'local' | 'remote') {
    if (!deviceId) return;
    const chosen = side === 'local' ? conflict.local : conflict.remote;
    const rejected = side === 'local' ? conflict.remote : conflict.local;
    // このDate.now()は render中ではなくonClickハンドラ(ボタン押下)から呼ばれる
    // (下のJSXでは`.map()`内のconflictを閉じ込めたイベントハンドラとして参照しているだけ
    // で、レンダー中に実行はされない)。react-hooks/purityはmap内のクロージャ経由の
    // 呼び出しを保守的に「レンダー中」とみなして誤検知するため、ここに限り無効化する。
    // eslint-disable-next-line react-hooks/purity
    const at = Date.now();
    await notesRepo.applyConflictResolution(
      conflict.termId,
      chosen.body,
      chosen.diagrams,
      deviceId,
      at,
      { body: rejected.body, diagrams: rejected.diagrams },
    );
    await noteConflictsRepo.setResolution(conflict.id, side, at);
    await loadConflicts();
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
          <ul>
            {conflicts.map((c) => (
              <li key={c.id} className="sync-conflict">
                <h4>{c.termId}</h4>
                <div className="sync-conflict-sides">
                  <div>
                    <p>この端末の内容({new Date(c.local.updatedAt).toLocaleString('ja-JP')})</p>
                    <p>{c.local.body}</p>
                    <button type="button" className="btn-secondary" onClick={() => void handleResolve(c, 'local')}>
                      こちらを採用
                    </button>
                  </div>
                  <div>
                    <p>相手の端末の内容({new Date(c.remote.updatedAt).toLocaleString('ja-JP')})</p>
                    <p>{c.remote.body}</p>
                    <button type="button" className="btn-secondary" onClick={() => void handleResolve(c, 'remote')}>
                      こちらを採用
                    </button>
                  </div>
                </div>
              </li>
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
