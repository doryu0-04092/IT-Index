import { useCallback, useEffect, useRef, useState } from 'react';
import type { ItIndexDB } from '../db';
import { ApiRequestError, fetchMe, login, signup } from '../sync/apiClient';
import { importV1Snapshot, pullFromRelay, pushToRelay, type SyncEngineDeps } from '../sync/syncEngine';
import { clearToken, getToken, setToken } from '../sync/tokenStore';
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
}

type AuthState =
  | { status: 'checking' }
  | { status: 'anonymous' }
  | { status: 'authed'; email: string; token: string };

interface SyncResultSummary {
  receivedBlobs: number;
  skippedBlobs: number;
  conflicts: number;
}

/**
 * 未ログイン時はサインアップ/ログインフォーム、ログイン済みならリレー同期の実行と
 * 競合解決、v1データ移行の入口をまとめる画面(要件定義書§4.2「サーバーリレー同期」)。
 * トークンはlocalStorage(sync/tokenStore.ts)に保存し、この画面はそれを唯一の
 * ログイン状態の入力源として扱う。
 */
export default function SyncScreen({
  db,
  deviceId,
  termsRepo,
  notesRepo,
  asksRepo,
  noteConflictsRepo,
  syncStateRepo,
}: SyncScreenProps) {
  const [auth, setAuth] = useState<AuthState>({ status: 'checking' });
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

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

  // マウント時: 保存済みトークンがあれば有効性を/api/auth/meで確認する
  // (期限切れ・失効時はログイン画面へ戻す)。useAppInit.tsのrunSeedImportと同じ理由で
  // 最初にawait Promise.resolve()を置き、effect内の同期的なsetState呼び出しから切り離す。
  const checkAuth = useCallback(async () => {
    await Promise.resolve();
    const token = getToken();
    if (!token) {
      setAuth({ status: 'anonymous' });
      return;
    }
    try {
      const me = await fetchMe(token);
      setAuth({ status: 'authed', email: me.email, token });
    } catch (err) {
      // トークンを破棄するのは401(失効・不正)のときだけ。ネットワーク断・サーバー停止でも
      // 破棄すると、オフラインのたびに再ログインが必要になる(要件定義書§5: サーバー停止時に
      // 止まってよいのは同期そのものだけ)。確認できないだけならログイン状態を保つ。
      if (err instanceof ApiRequestError && err.status === 401) {
        clearToken();
        setAuth({ status: 'anonymous' });
        return;
      }
      setAuth({ status: 'authed', email: '(オフライン: 次の接続時に確認します)', token });
    }
  }, []);

  useEffect(() => {
    // マウント時のトークン確認は、ユーザー操作に紐づくイベントハンドラが存在しない
    // 起動時副作用であり、effectで行うのが正しい(useAppInit.tsの同種コメント参照)。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    if (auth.status === 'authed') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadConflicts();
    }
  }, [auth.status, loadConflicts]);

  async function handleAuthSubmit(mode: 'signup' | 'login', email: string, password: string) {
    setAuthBusy(true);
    setAuthError(null);
    try {
      const result = mode === 'signup' ? await signup(email, password) : await login(email, password);
      setToken(result.token);
      const me = await fetchMe(result.token);
      setAuth({ status: 'authed', email: me.email, token: result.token });
    } catch (err) {
      setAuthError(err instanceof ApiRequestError ? err.message : 'サーバーに接続できませんでした');
    } finally {
      setAuthBusy(false);
    }
  }

  function handleLogout() {
    clearToken();
    setAuth({ status: 'anonymous' });
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
    } catch (err) {
      setSyncError(err instanceof ApiRequestError ? err.message : '同期に失敗しました');
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
    return <AuthForms busy={authBusy} error={authError} onSubmit={handleAuthSubmit} />;
  }

  return (
    <section className="sync-screen">
      <p>
        ログイン中: {auth.email} <button type="button" className="btn-secondary" onClick={handleLogout}>ログアウト</button>
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

function AuthForms({
  busy,
  error,
  onSubmit,
}: {
  busy: boolean;
  error: string | null;
  onSubmit: (mode: 'signup' | 'login', email: string, password: string) => void;
}) {
  const [mode, setMode] = useState<'signup' | 'login'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  return (
    <section className="sync-auth">
      <div className="sync-auth-tabs" role="tablist">
        <button type="button" aria-pressed={mode === 'login'} onClick={() => setMode('login')}>
          ログイン
        </button>
        <button type="button" aria-pressed={mode === 'signup'} onClick={() => setMode('signup')}>
          新規登録
        </button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(mode, email, password);
        }}
      >
        <label htmlFor="sync-email">メールアドレス</label>
        <input
          id="sync-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <label htmlFor="sync-password">パスワード</label>
        <input
          id="sync-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? '送信しています…' : mode === 'signup' ? '登録する' : 'ログインする'}
        </button>
        {error && <p className="sync-error">{error}</p>}
      </form>
    </section>
  );
}
