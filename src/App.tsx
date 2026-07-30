import { useEffect, useMemo, useState } from 'react';
import { createDynamicAiClient } from './ai/providers';
import { createCommitOrchestrator } from './ai/commitOrchestrator';
import type { AutoUpdateExistingTermsMode } from './ai/distribution';
import { logAiError } from './ai/logError';
import { buildSubjectContext, type SubjectContext } from './ai/subjectContext';
import { db } from './db';
import { createApiKeyStore, getSessionCredential } from './keystore/apiKeyStore';
import { createBrowserWebAuthnClient } from './keystore/webauthn';
import {
  runLocalExport,
  runLocalImportBeforeCommit,
  runLocalImportIfChanged,
  type LocalFolderDeps,
} from './localData/localFolderSync';
import { createAsksRepository } from './repositories/asks';
import { createChatRepository } from './repositories/chat';
import { createKeyStoreRepository } from './repositories/keyStore';
import { createNotesRepository } from './repositories/notes';
import { createSettingsRepository } from './repositories/settings';
import { createSyncFolderRepository } from './repositories/syncFolder';
import { createTermsRepository } from './repositories/terms';
import { fetchSeedFile, importSeed } from './seedImport';
import ChatScreen from './ui/pc/ChatScreen';
import HistoryScreen, { type HistoryView } from './ui/pc/HistoryScreen';
import SearchScreen from './ui/pc/SearchScreen';
import SettingsModal from './ui/pc/SettingsModal';
import TermDetailScreen from './ui/pc/TermDetailScreen';

type Screen =
  | { name: 'search' }
  | { name: 'detail'; termId: string }
  | { name: 'chat'; sessionId: string; subject: SubjectContext; returnTermId: string | null }
  | { name: 'history'; view: HistoryView };

export default function App() {
  const [seedStatus, setSeedStatus] = useState('シードを確認中…');
  const [seedSettled, setSeedSettled] = useState(false);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [autoUpdateExistingTerms, setAutoUpdateExistingTerms] = useState<AutoUpdateExistingTermsMode>('askedOnly');
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>({ name: 'search' });
  const [activeChatSessionId, setActiveChatSessionId] = useState<string | null>(null);
  const [hasPersistedKey, setHasPersistedKey] = useState(false);
  const [keyReady, setKeyReady] = useState(() => getSessionCredential() !== null);
  const [authenticating, setAuthenticating] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [localFolder, setLocalFolder] = useState<FileSystemDirectoryHandle | null>(null);

  const termsRepo = useMemo(() => createTermsRepository(db), []);
  const notesRepo = useMemo(() => createNotesRepository(db), []);
  const asksRepo = useMemo(() => createAsksRepository(db), []);
  const chatRepo = useMemo(() => createChatRepository(db), []);
  const settingsRepo = useMemo(() => createSettingsRepository(db), []);
  const syncFolderRepo = useMemo(() => createSyncFolderRepository(db), []);
  const keyStoreRepo = useMemo(() => createKeyStoreRepository(db), []);
  const webauthn = useMemo(() => createBrowserWebAuthnClient(), []);
  const apiKeyStore = useMemo(() => createApiKeyStore(keyStoreRepo, webauthn), [keyStoreRepo, webauthn]);
  const claude = useMemo(() => createDynamicAiClient(getSessionCredential), []);

  // docs/local-data.md。deviceId が読み込まれるまでは作らない（notesRepo.applyCommit に
  // 実在の deviceId を要するため、commitOrchestrator と同じ理由）。
  const localFolderDeps = useMemo<LocalFolderDeps | null>(() => {
    if (deviceId === null) return null;
    return { termsRepo, notesRepo, settingsRepo, deviceId };
  }, [termsRepo, notesRepo, settingsRepo, deviceId]);

  // deviceId が読み込まれるまでは作らない——commitOrchestrator は書き込みに実在の
  // deviceId を要するため（要件定義書§5.3、2026-07-30改訂で承認画面を廃止し常に自動反映するようにした）。
  const commitOrchestrator = useMemo(() => {
    if (deviceId === null) return null;
    return createCommitOrchestrator({
      chatRepo,
      termsRepo,
      notesRepo,
      claude,
      asksRepo,
      deviceId,
      autoUpdateExistingTerms,
      onError: (sessionId, error) => {
        logAiError(`commitOrchestrator(session=${sessionId})`, error);
        setGlobalError(`確定処理に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
      },
    });
  }, [chatRepo, termsRepo, notesRepo, claude, asksRepo, deviceId, autoUpdateExistingTerms]);

  useEffect(() => {
    importSeed(fetchSeedFile, termsRepo, settingsRepo)
      .then(async (result) => {
        const count = (await termsRepo.getAll()).length;
        if (result.imported) setSeedStatus(`シードを取り込みました（${count}語）`);
        else if (result.reason === 'already up to date') setSeedStatus(`最新です（${count}語）`);
        else setSeedStatus(`取り込みを中止しました: ${result.reason}`);
      })
      .catch((err: unknown) => {
        setSeedStatus(`取り込みに失敗しました: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => setSeedSettled(true));

    settingsRepo.get().then((s) => {
      setDeviceId(s.deviceId);
      setAutoUpdateExistingTerms(s.autoUpdateExistingTerms);
    });
  }, [termsRepo, settingsRepo]);

  useEffect(() => {
    // docs/local-data.md「自動化」。起動時、選択済みフォルダの権限が残っていれば
    // （queryPermission は権限を求めず確認するだけなのでユーザー操作なしで呼べる）
    // 無操作で取り込む。切れていた場合は何もしない——requestPermission はユーザー操作を
    // 伴わない自動呼び出しをブラウザに拒否されるため（keyReady の復元と同じ理由）、
    // 設定画面の「今すぐ読み込む」ボタン（LocalFolderPanel）で復旧する。
    if (!seedSettled || !localFolderDeps) return;
    syncFolderRepo.get().then(async (dir) => {
      if (!dir) return;
      setLocalFolder(dir);
      const granted = (await dir.queryPermission({ mode: 'readwrite' })) === 'granted';
      if (!granted) return;
      const outcome = await runLocalImportIfChanged(dir, localFolderDeps);
      if (outcome.result && !outcome.result.ok) {
        setGlobalError(`ローカルデータの取り込みを中止しました: ${outcome.result.reason}`);
      }
    });
  }, [seedSettled, localFolderDeps, syncFolderRepo]);

  useEffect(() => {
    // サイトに入った時点で「保存済みのAPIキーがあるか」だけ確認する（復号はしない）。
    // 実際の復元（WebAuthn呼び出し）はユーザーがボタンを押した瞬間に行う——
    // navigator.credentials.get() はユーザー操作を伴わない自動呼び出しをブラウザに
    // 拒否されることがあり、ページ読み込み直後に自動で試すと静かに失敗しやすいため
    // （実際に報告された不具合。docs/ui-pc.md 参照）。
    if (!keyReady) {
      apiKeyStore.hasPersistedCredential().then(setHasPersistedKey);
    }
  }, [apiKeyStore, keyReady]);

  async function handleAuthenticate() {
    setAuthenticating(true);
    setAuthError(null);
    try {
      const restored = await apiKeyStore.tryRestore();
      if (restored) {
        setKeyReady(true);
      } else {
        setAuthError('認証できませんでした（キャンセルされたか、この端末のパスキーではありません）。');
      }
    } catch (err) {
      logAiError('App.handleAuthenticate', err);
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthenticating(false);
    }
  }

  // 要件定義書§5.3「チャットの主題（SubjectContext）」。termId が確定している場合のみ
  // 用語モードにする（最上位検索候補への自動ひも付けはしない）。「話題を変える」も
  // このstartChat()を呼ぶだけでよい——既存のトリガー①（別の用語のチャットを開いた＝
  // 前の会話は終わり）がそのまま「話題変更時は自動で確定してから切り替える」を満たす。
  // returnTermId: 単語詳細画面の「この語についてAIに聞く」から来た場合のみ、その詳細画面へ
  // 戻れるようにする（検索結果一覧やAI検索欄から直接チャットを開始した場合はnullのまま）。
  //
  // termIdについて、確定せずに残っている（status:'open'）セッションが既にあれば、それを新規作成
  // せず再開する——ホームの「AIによる単語更新待ち」一覧から再度その語を開いた場合や、単語詳細画面で
  // 「この語についてAIに聞く」をもう一度押した場合が該当する。
  // 2026-07-30改訂（ローカルデータ層導入）: 確定操作はボタン実行のみにしたため、別の用語の
  // チャットを開いても元のセッションは自動確定しない。「AIによる単語更新待ち」一覧に残り続け、
  // 利用者が明示的に確定するまで開いたままになる（docs/local-data.md）。
  async function startChat(termId: string | null, seedQuery: string | null, returnTermId: string | null = null) {
    const existing = termId ? await chatRepo.findOpenSessionByTermId(termId) : undefined;
    const session = existing ?? (await chatRepo.createSession(termId));

    const subject = await buildSubjectContext(termId, seedQuery, { termsRepo, notesRepo });
    setActiveChatSessionId(session.id);
    setScreen({ name: 'chat', sessionId: session.id, subject, returnTermId });
  }

  // docs/local-data.md「確定処理の順序」。① Claude Code の編集を先に取り込む
  // → ② AI要約処理・DB書き込み（commitOrchestrator） → ③ 最新状態をファイルへ書き戻す。
  // ①を先に行うことで、Claude Code のファイル編集が既定で優先される
  // （②がそのセッションが触れた語に限って上書きし得るが、それ以外は①の内容がそのまま残る）。
  // フォルダが未設定の場合は①③とも何もしない（従来どおりDBのみで完結する）。
  async function commitSessionWithLocalSync(sessionId: string): Promise<void> {
    if (localFolder && localFolderDeps) {
      try {
        await runLocalImportBeforeCommit(localFolder, localFolderDeps);
      } catch (error) {
        logAiError(`localFolderSync.import(session=${sessionId})`, error);
      }
    }

    await commitOrchestrator?.triggerCommit(sessionId);

    if (localFolder && localFolderDeps) {
      try {
        await runLocalExport(localFolder, localFolderDeps);
      } catch (error) {
        logAiError(`localFolderSync.export(session=${sessionId})`, error);
        setGlobalError('ローカルフォルダへの書き出しに失敗しました。');
      }
    }
  }

  // 明示的な確定操作（確定ボタン）。確定処理はバックグラウンドで進め、クリックした時点で
  // ローカル検索画面へ戻す——確定結果を待たせない（2026-07-29）。
  // 2026-07-30: 承認画面を廃止したため、確定＝そのままDBへの自動反映になる。
  function commitAndReturnToSearch(sessionId: string) {
    void commitSessionWithLocalSync(sessionId);
    setActiveChatSessionId(null);
    setScreen({ name: 'search' });
  }

  // ホームの「AIによる単語更新待ち」一覧から、チャット画面を開かずその場で確定する。
  // 画面遷移はしない点だけがcommitAndReturnToSearchと異なる（既にsearch画面にいるため）。
  function commitPendingTerm(sessionId: string) {
    void commitSessionWithLocalSync(sessionId);
    if (activeChatSessionId === sessionId) setActiveChatSessionId(null);
  }

  // 要件定義書§5.4「ローカル検索の確定」。検索結果一覧から用語を選んで詳細を開いた
  // 瞬間だけを「確定」とみなす（検索欄への入力や一覧の閲覧だけでは呼ばない）。
  // AIチャット確定（source:'ai'）より弱い重みで加算する（computeWeights.ts）。
  function handleSelectFromSearch(termId: string) {
    if (deviceId) {
      void asksRepo.addSearchConfirm(termId, deviceId, Date.now());
    }
    setScreen({ name: 'detail', termId });
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>IT-Index</h1>
        {globalError && (
          <p className="chat-error">
            {globalError}{' '}
            <button type="button" className="dismiss-error" onClick={() => setGlobalError(null)}>
              ✕
            </button>
          </p>
        )}
        {hasPersistedKey && !keyReady && (
          <div className="auth-banner">
            <span>保存済みのAPIキーがあります。</span>
            <button type="button" onClick={handleAuthenticate} disabled={authenticating}>
              {authenticating ? '認証中…' : 'パスキーで認証'}
            </button>
            <button type="button" onClick={() => setHasPersistedKey(false)} disabled={authenticating}>
              今は使わない
            </button>
            {authError && <span className="chat-error">{authError}</span>}
          </div>
        )}
      </header>
      <main>
        {!seedSettled ? null : screen.name === 'search' ? (
          <SearchScreen
            termsRepo={termsRepo}
            chatRepo={chatRepo}
            seedStatus={seedStatus}
            onSelectTerm={handleSelectFromSearch}
            onStartChat={(termId, seedQuery) => void startChat(termId, seedQuery)}
            onOpenPendingTerm={(termId) => void startChat(termId, null)}
            onCommitPending={commitPendingTerm}
            onOpenHistory={(view) => setScreen({ name: 'history', view })}
          />
        ) : screen.name === 'detail' ? (
          <TermDetailScreen
            termId={screen.termId}
            termsRepo={termsRepo}
            notesRepo={notesRepo}
            onBack={() => setScreen({ name: 'search' })}
            onStartChat={(termId) => void startChat(termId, null, termId)}
          />
        ) : screen.name === 'chat' ? (
          <ChatScreen
            sessionId={screen.sessionId}
            subject={screen.subject}
            returnTermId={screen.returnTermId}
            chatRepo={chatRepo}
            termsRepo={termsRepo}
            claude={claude}
            apiKeyStore={apiKeyStore}
            keyReady={keyReady}
            onKeyReady={() => setKeyReady(true)}
            onCommit={commitAndReturnToSearch}
            onChangeSubject={(termId) => void startChat(termId, null)}
            onBack={() => {
              // 「確定する」を押さずに離れた場合、自動確定はしない（2026-07-30改訂）。
              // セッションは open のまま「AIによる単語更新待ち」一覧に残り、
              // 利用者が明示的に確定するまでそのまま残る（docs/local-data.md）。
              setScreen({ name: 'search' });
            }}
            onBackToTerm={(termId) => {
              setScreen({ name: 'detail', termId });
            }}
          />
        ) : (
          <HistoryScreen
            asksRepo={asksRepo}
            termsRepo={termsRepo}
            initialView={screen.view}
            onSelectTerm={(termId) => setScreen({ name: 'detail', termId })}
            onBack={() => setScreen({ name: 'search' })}
          />
        )}
      </main>

      <button type="button" className="settings-gear" onClick={() => setSettingsOpen(true)} aria-label="設定">
        ⚙
      </button>
      {settingsOpen && (
        <SettingsModal
          apiKeyStore={apiKeyStore}
          onClose={() => setSettingsOpen(false)}
          onCredentialReady={() => setKeyReady(true)}
          autoUpdateExistingTerms={autoUpdateExistingTerms}
          onChangeAutoUpdateExistingTerms={(mode) => {
            setAutoUpdateExistingTerms(mode);
            void settingsRepo.setAutoUpdateExistingTerms(mode);
          }}
          localFolder={localFolder}
          onLocalFolderChange={setLocalFolder}
          syncFolderRepo={syncFolderRepo}
          localFolderDeps={localFolderDeps}
        />
      )}
    </div>
  );
}
