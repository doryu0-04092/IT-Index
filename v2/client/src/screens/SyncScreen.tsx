import { useCallback, useEffect, useRef, useState } from 'react';
import type { ItIndexDB } from '../db';
import { ApiRequestError, fetchMe, login, signup, testAiConnection } from '../sync/apiClient';
import { importV1Snapshot, pullFromRelay, pushToRelay, type SyncEngineDeps } from '../sync/syncEngine';
import { clearToken, getToken, setToken } from '../sync/tokenStore';
import {
  clearAiCredential,
  getAiCredential,
  maskApiKey,
  providerLabel,
  saveVerifiedCredential,
  type AiProvider,
} from '../sync/apiKeyStore';
import type { AsksRepository } from '../repositories/asks';
import type { NoteConflictRecord } from '../types';
import type { NoteConflictsRepository } from '../repositories/noteConflicts';
import type { NotesRepository } from '../repositories/notes';
import type { SyncStateRepository } from '../repositories/syncState';
import type { TermsRepository } from '../repositories/terms';
import ThemeSwitcher from '../lib/ThemeSwitcher';
import type { ThemeChoice } from '../lib/theme';

export interface SyncScreenProps {
  db: ItIndexDB;
  /** シード取り込み・deviceId発行が終わるまでnull(useAppInit参照)。読み込み中は操作させない */
  deviceId: string | null;
  termsRepo: TermsRepository;
  notesRepo: NotesRepository;
  asksRepo: AsksRepository;
  noteConflictsRepo: NoteConflictsRepository;
  syncStateRepo: SyncStateRepository;
  /**
   * テーマ手動切替(依頼者指定)。設定タブが無い現時点では暫定でこの画面の末尾に置く
   * (PR-Hで設定タブへ移設予定。App.tsxが状態を持ち、ここでは表示と変更通知だけを担う)。
   */
  themeChoice: ThemeChoice;
  onThemeChange: (choice: ThemeChoice) => void;
  /** 同期成功・失敗をトースト通知するための呼び出し(依頼者指定。App.tsxのToastへ接続) */
  onSyncNotify?: (message: string, variant: 'error' | 'info') => void;
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
  themeChoice,
  onThemeChange,
  onSyncNotify,
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
      // 完了/失敗をトースト通知する(依頼者指定。v1でToastを出していた「進行中/失敗」に
      // 相当する操作として同期の完了もここに含める。既存のインライン表示(lastResult等)は
      // そのまま残し、Toastは追加の通知として重ねる)。
      onSyncNotify?.(
        `同期しました(受信${outcome.receivedBlobs}件・競合${outcome.conflicts}件)。`,
        'info',
      );
    } catch (err) {
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
    return (
      <>
        <AuthForms busy={authBusy} error={authError} onSubmit={handleAuthSubmit} />
        <ThemeSwitcher choice={themeChoice} onChange={onThemeChange} />
      </>
    );
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

      <ApiKeySection token={auth.token} />

      <ThemeSwitcher choice={themeChoice} onChange={onThemeChange} />
    </section>
  );
}

/**
 * 利用者が自分のAPIキーを持ち込む設定(BYOK。docs/v2/architecture.md §5)。
 *
 * 新画面を作らず同期画面に置いた理由: この設定はアカウント・サーバー利用に紐づく設定で、
 * 同期画面が既に「サーバーとのやり取りの設定」を集めている唯一の場所であること。
 * また未ログインではAIチャット自体が使えず、この画面はログイン時のみ本体を描画するため、
 * 「設定できるのに使えない」状態が構造的に起きない(navigation.tsを増やさずに済む)。
 *
 * 保存の唯一の入口は接続テストの成功(handleTest)。テストに通っていないキーは保存されず、
 * チャットにも使われない(sync/apiKeyStore.ts の verified)。「動作保証はしないが、
 * 接続テストが通ったキーなら使える」という建て付けをUIの導線として固定する。
 */
function ApiKeySection({ token }: { token: string }) {
  // localStorageの読み取りはこの画面がマウントされた時点の状態でよい(保存・削除は
  // すべてこのコンポーネント内の操作なので、stateを唯一の表示源にできる)。
  const [saved, setSaved] = useState(() => getAiCredential());
  // 初期値は保存済みの設定に合わせる(2回目以降のレンダーでは初期化式は評価されない)。
  const [provider, setProvider] = useState<AiProvider>(saved?.provider ?? 'openai');
  const [keyDraft, setKeyDraft] = useState('');
  const [modelDraft, setModelDraft] = useState(saved?.model ?? '');
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleTest() {
    const key = keyDraft.trim();
    if (key === '' || testing) return;
    setTesting(true);
    setMessage(null);
    setError(null);
    const model = modelDraft.trim() === '' ? undefined : modelDraft.trim();
    try {
      const result = await testAiConnection(token, { key, provider, model });
      // 成功したときに初めて保存する(失敗したキーは端末にも残さない)
      saveVerifiedCredential({ key, provider, model });
      setSaved(getAiCredential());
      setKeyDraft(''); // 入力欄にキーを残さない(画面に平文が出続けないようにする)
      setMessage(`接続できました(${providerLabel(result.provider)}・${result.model})。保存しました。`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'サーバーに接続できませんでした');
    } finally {
      setTesting(false);
    }
  }

  function handleClear() {
    clearAiCredential();
    setSaved(null);
    setKeyDraft('');
    setModelDraft('');
    setMessage('自分のAPIキーを削除しました。以降は共有のキー(回数上限あり)で実行されます。');
    setError(null);
  }

  const statusText = (() => {
    if (saved === null) return '現在の状態: 未設定(共有のキーを使用)';
    const base = `${providerLabel(saved.provider)}・${maskApiKey(saved.key)}${saved.model ? `・${saved.model}` : '・既定モデル'}`;
    return saved.verified
      ? `現在の状態: 検証済み(${base})`
      : `現在の状態: 未検証(${base})。接続テストに通るまでチャットには使いません`;
  })();

  return (
    <div className="sync-api-key">
      <h3>自分のAPIキーを使う</h3>
      <p className="status-text">
        自分のキーを使うと回数上限なしでAIチャットを利用できます。キーはこの端末にのみ保存され、
        サーバーには保存されません。未設定の場合は共有のキー(1日あたりの回数上限あり)で動きます。
      </p>
      <p className="status-text">
        <strong>
          必ず各プロバイダのコンソールで支出上限(Monthly budget)を設定してください。
        </strong>
        キーが漏れた場合の被害を、その上限までに抑えるための備えです。
      </p>
      <p className="status-text">
        OpenAI以外のプロバイダは実動作の確認をしていません。接続テストが通れば利用できますが、
        応答品質は保証しません。
      </p>

      <p className="status-text" data-testid="api-key-status">
        {statusText}
      </p>

      <label htmlFor="sync-api-provider">プロバイダ</label>
      <select
        id="sync-api-provider"
        value={provider}
        onChange={(e) => setProvider(e.target.value as AiProvider)}
      >
        <option value="openai">OpenAI</option>
        <option value="anthropic">Anthropic</option>
      </select>

      <label htmlFor="sync-api-key-input">APIキー</label>
      <input
        id="sync-api-key-input"
        type="password"
        autoComplete="off"
        value={keyDraft}
        placeholder={saved === null ? '' : '(保存済み。変更する場合のみ入力)'}
        onChange={(e) => setKeyDraft(e.target.value)}
      />

      <label htmlFor="sync-api-model-input">モデル名(任意)</label>
      <input
        id="sync-api-model-input"
        type="text"
        autoComplete="off"
        value={modelDraft}
        onChange={(e) => setModelDraft(e.target.value)}
      />
      <p className="status-text">空欄ならプロバイダごとの既定モデルを使います。</p>

      <div className="sync-api-key-actions">
        <button
          type="button"
          className="btn-primary"
          onClick={() => void handleTest()}
          disabled={testing || keyDraft.trim() === ''}
        >
          {testing ? '接続を確認しています…' : '接続テスト'}
        </button>
        <button type="button" className="btn-secondary" onClick={handleClear} disabled={saved === null}>
          削除する
        </button>
      </div>
      {message && <p className="status-text">{message}</p>}
      {error && <p className="sync-error">{error}</p>}
    </div>
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
