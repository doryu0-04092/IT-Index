import { Capacitor } from '@capacitor/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createDynamicAiClient } from './ai/providers';
import { createCommitOrchestrator } from './ai/commitOrchestrator';
import type { AutoUpdateExistingTermsMode } from './ai/distribution';
import { logAiError } from './ai/logError';
import { buildSubjectContext, type SubjectContext } from './ai/subjectContext';
import { isUnsupportedBrowser } from './browserSupport';
import { db } from './db';
import { createApiKeyStore, getSessionCredential } from './keystore/apiKeyStore';
import { createAndroidSecureApiKeyStore } from './keystore/androidSecureApiKeyStore';
import { createBrowserWebAuthnClient } from './keystore/webauthn';
import type { ManualSyncDeps } from './manualSync/sync';
import { persistScreen, readPersistedScreen, type PersistedScreen } from './screenPersistence';
import { hasSeenOnboarding, markOnboardingSeen } from './ui/onboarding';
import { getInitialTheme, persistTheme, readStoredTheme } from './ui/theme';
import { createAsksRepository } from './repositories/asks';
import { createChatRepository } from './repositories/chat';
import { createKeyStoreRepository } from './repositories/keyStore';
import { createNotesRepository } from './repositories/notes';
import { createSettingsRepository } from './repositories/settings';
import { createTermsRepository } from './repositories/terms';
import { fetchSeedFile, importSeed } from './seedImport';
import type { HistoryView } from './ui/pc/HistoryScreen';
import type { TopNavCurrent } from './ui/pc/TopNav';
import type { UiSet } from './ui/uiSet';

type Screen =
  | { name: 'search' }
  | { name: 'detail'; termId: string }
  | { name: 'chat'; sessionId: string; subject: SubjectContext; returnTermId: string | null }
  | { name: 'history'; view: HistoryView }
  | { name: 'index' }
  | { name: 'settings' }
  | { name: 'link' };

// 画面切替時にフェードインを再生させるためのReact key。screen.nameが変わった時だけでなく、
// 同じ'chat'のまま別セッションに移った場合（話題変更）にも再生させたいのでsessionId等も含める。
/** TopNavでどの項目をactive表示するか。詳細画面や用語ひも付きのチャットはナビ項目に対応しないためnull */
function topNavCurrent(screen: Screen): TopNavCurrent {
  if (screen.name === 'search') return 'search';
  if (screen.name === 'history') return 'history';
  if (screen.name === 'index') return 'index';
  if (screen.name === 'settings') return 'settings';
  if (screen.name === 'link') return 'link';
  return null;
}

function screenKey(screen: Screen): string {
  switch (screen.name) {
    case 'detail':
      return `detail:${screen.termId}`;
    case 'chat':
      return `chat:${screen.sessionId}`;
    case 'history':
      return `history:${screen.view}`;
    default:
      return screen.name;
  }
}

/** リロード時の文脈復元（#39）用に、subject（AIへ渡す文脈）を除いた軽量な形に落とす */
function toPersistedScreen(screen: Screen): PersistedScreen {
  switch (screen.name) {
    case 'search':
      return { name: 'search' };
    case 'detail':
      return { name: 'detail', termId: screen.termId };
    case 'chat':
      return { name: 'chat', sessionId: screen.sessionId, returnTermId: screen.returnTermId };
    case 'history':
      return { name: 'history', view: screen.view };
    case 'index':
      return { name: 'index' };
    case 'settings':
      return { name: 'settings' };
    case 'link':
      return { name: 'link' };
  }
}

/**
 * 統括（画面遷移・シード取り込み・確定オーケストレーション・認証）を担う。
 *
 * 画面コンポーネントは `ui` で差し替える。PC版とAndroid版は独立した一式だが
 * （docs/ui-pc.md:8）、統括ロジックそのものは共通で、ここ1箇所にしか無い。
 */
export default function App({ ui }: { ui: UiSet }) {
  const {
    ChatScreen,
    HistoryScreen,
    LinkModal,
    OnboardingModal,
    SearchScreen,
    SettingsModal,
    TermDetailScreen,
    Toast,
    TopNav,
  } = ui;
  const [seedError, setSeedError] = useState<string | null>(null);
  const [seedSettled, setSeedSettled] = useState(false);
  // シード取り込みに失敗した場合の再試行ボタン（SearchScreen）を押すたびに増分する。
  // termsRepo自体のインスタンスは変わらないため、SearchScreen側のtermsRepo.getAll()を
  // 再実行させるトリガーとして使う（#38対応）。
  const [seedRefreshTick, setSeedRefreshTick] = useState(0);
  // リロード時の文脈復元（#39）を一度だけ試みるためのガード。seedSettled後に1回だけ実行する。
  const [screenRestoreAttempted, setScreenRestoreAttempted] = useState(false);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [autoUpdateExistingTerms, setAutoUpdateExistingTerms] = useState<AutoUpdateExistingTermsMode>('askedOnly');
  const [globalError, setGlobalError] = useState<string | null>(null);
  // 確定処理は fire-and-forget のため（#40対応）、実行中であることをトーストで示す。
  const [commitInProgress, setCommitInProgress] = useState(false);
  // 確定に失敗したセッションIDの集合。「AIによる単語更新待ち」一覧に失敗マークを表示するため
  // に使う（#41対応）。次に確定に成功したら該当セッションを取り除く。
  const [failedCommitSessionIds, setFailedCommitSessionIds] = useState<Set<string>>(new Set());
  const [screen, setScreen] = useState<Screen>({ name: 'search' });
  const [activeChatSessionId, setActiveChatSessionId] = useState<string | null>(null);
  const [hasPersistedKey, setHasPersistedKey] = useState(false);
  const [keyReady, setKeyReady] = useState(() => getSessionCredential() !== null);
  const [authenticating, setAuthenticating] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  // 確定処理（commitSession）が完了するたびに増分する。
  // SearchScreen の「AIによる単語更新待ち」一覧の再取得トリガー。
  const [pendingRefreshTick, setPendingRefreshTick] = useState(0);
  const [theme, setTheme] = useState(() =>
    getInitialTheme(window.matchMedia('(prefers-color-scheme: dark)').matches, readStoredTheme()),
  );
  const [showOnboarding, setShowOnboarding] = useState(() => !hasSeenOnboarding());
  // 要件定義書§3「非対応環境で開かれた場合は、その旨を明示するバナーを表示する」対応（#37）。
  // 対応: Android(Chrome) / PC(Chrome・Edge)。非対応: iPhone・iPad・macOS Safari。
  const [browserWarningDismissed, setBrowserWarningDismissed] = useState(false);
  const showBrowserWarning = useMemo(() => isUnsupportedBrowser(navigator.userAgent), []);

  function dismissOnboarding(dontShowAgain: boolean) {
    if (dontShowAgain) markOnboardingSeen();
    setShowOnboarding(false);
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    persistTheme(theme);
  }, [theme]);

  // URLルーティングを持たないため、画面遷移してもhistoryエントリが増えず、ブラウザの
  // 戻るボタンを押すとアプリの前画面ではなく「流入前のページ」へ即座に離脱し白紙化して
  // いた（#35）。画面が変わるたびにダミーのhistoryエントリを積み、popstateで検索画面へ
  // 戻すことで、少なくとも白紙化は防ぐ。
  useEffect(() => {
    window.history.pushState({ appScreen: true }, '');
  }, [screen]);

  // リロード時の文脈復元（#39）。URLは変えず、sessionStorageに「どの画面にいたか」の
  // 軽量な識別子だけを保存する（本格的なルーティング導入は見送り、本人確認済み）。
  // 保存はscreenが変わるたびに行う。復元は下のuseEffect（seedSettled後に一度だけ）で行う。
  useEffect(() => {
    // 復元処理（下のuseEffect）が完了する前に保存すると、初期値{name:'search'}で
    // 上書きしてしまい、リロード直後にsessionStorageの内容を消してしまう。
    // 復元試行が済むまでは保存しない。
    if (!screenRestoreAttempted) return;
    persistScreen(toPersistedScreen(screen));
  }, [screen, screenRestoreAttempted]);

  useEffect(() => {
    function handlePopState() {
      setActiveChatSessionId(null);
      setScreen({ name: 'search' });
    }
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const termsRepo = useMemo(() => createTermsRepository(db), []);
  const notesRepo = useMemo(() => createNotesRepository(db), []);
  const asksRepo = useMemo(() => createAsksRepository(db), []);
  const chatRepo = useMemo(() => createChatRepository(db), []);
  const settingsRepo = useMemo(() => createSettingsRepository(db), []);
  const keyStoreRepo = useMemo(() => createKeyStoreRepository(db), []);
  const webauthn = useMemo(() => createBrowserWebAuthnClient(), []);
  // Android実機はWebAuthnのパスキーが未設定のことが多く保存機能が使えないため、
  // Android Keystore＋端末標準のロック解除（生体認証/PIN等）を使う実装に差し替える
  // （ユーザー指摘。src/keystore/androidSecureApiKeyStore.ts）。ApiKeyStoreインターフェースは
  // 共通のため、呼び出し側（SettingsModal・ApiKeyPrompt）はプラットフォームを意識しない。
  const apiKeyStore = useMemo(
    () => (Capacitor.isNativePlatform() ? createAndroidSecureApiKeyStore(keyStoreRepo) : createApiKeyStore(keyStoreRepo, webauthn)),
    [keyStoreRepo, webauthn],
  );
  const claude = useMemo(() => createDynamicAiClient(getSessionCredential), []);

  // 「連携」（LinkModal）用。deviceId が読み込まれるまでは作らない
  // （manualSync/sync.ts の各関数が書き込みに実在の deviceId を要するため）。
  const manualSyncDeps = useMemo<ManualSyncDeps | null>(() => {
    if (deviceId === null) return null;
    return { termsRepo, notesRepo, asksRepo, deviceId };
  }, [termsRepo, notesRepo, asksRepo, deviceId]);

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
        setFailedCommitSessionIds((prev) => new Set(prev).add(sessionId));
      },
    });
  }, [chatRepo, termsRepo, notesRepo, claude, asksRepo, deviceId, autoUpdateExistingTerms]);

  const runSeedImport = useCallback(() => {
    setSeedError(null);
    return importSeed(fetchSeedFile, termsRepo, settingsRepo)
      .then((result) => {
        // 「取り込みました/最新です」は登録単語数の表示（SearchScreen側でterms.lengthから算出）に
        // 置き換えたため、ここでは異常時のみ状態を持つ。
        if (!result.imported && result.reason !== 'already up to date') {
          setSeedError(`取り込みを中止しました: ${result.reason}`);
        }
      })
      .catch((err: unknown) => {
        setSeedError(`取り込みに失敗しました: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        setSeedSettled(true);
        setSeedRefreshTick((t) => t + 1);
      });
  }, [termsRepo, settingsRepo]);

  useEffect(() => {
    runSeedImport();

    settingsRepo.get().then((s) => {
      setDeviceId(s.deviceId);
      setAutoUpdateExistingTerms(s.autoUpdateExistingTerms);
    });
  }, [runSeedImport, settingsRepo]);

  // リロード時の文脈復元（#39）。seedSettled後（＝termsRepo等が使える状態）に一度だけ試みる。
  // 保存されていたtermId・sessionIdが（削除等で）既に存在しない場合は検索画面のまま何もしない
  // ——復元を試みて失敗した痕跡を利用者に見せる必要はなく、静かに諦めれば十分なため。
  useEffect(() => {
    if (!seedSettled || screenRestoreAttempted) return;
    setScreenRestoreAttempted(true);

    const persisted = readPersistedScreen();
    if (!persisted) return;

    (async () => {
      switch (persisted.name) {
        case 'detail': {
          const term = await termsRepo.getById(persisted.termId);
          if (term) setScreen({ name: 'detail', termId: persisted.termId });
          break;
        }
        case 'chat': {
          // resumeChatSession()はreturnTermIdを常にnullにする（一覧からの再開はnullで問題ないため）。
          // ここはリロード前の状態（returnTermIdの有無）をそのまま復元する必要があるため使わない。
          const session = await chatRepo.getSession(persisted.sessionId);
          if (session) {
            const subject = await buildSubjectContext(session.termId, null, { termsRepo, notesRepo });
            setActiveChatSessionId(session.id);
            setScreen({ name: 'chat', sessionId: session.id, subject, returnTermId: persisted.returnTermId });
          }
          break;
        }
        case 'history':
          setScreen({ name: 'history', view: persisted.view });
          break;
        case 'index':
          setScreen({ name: 'index' });
          break;
        case 'settings':
          setScreen({ name: 'settings' });
          break;
        case 'link':
          setScreen({ name: 'link' });
          break;
        default:
          // 'search' は初期値のまま何もしない
          break;
      }
    })();
  }, [seedSettled, screenRestoreAttempted, termsRepo, notesRepo, chatRepo]);

  // 2026-08-04改訂: 起動時の自動確定を廃止した。理由は2つ:
  // (1) APIキーはセッション限りの保持なので起動直後は必ず未認証で、この処理が先に走ると
  //     「確定処理に失敗しました: APIキーが設定されていません」が必ず出ていた
  //     （docs/ui-pc.md §3 バグ6と同じ形の再発）
  // (2) 「AIと会話した内容は自動では保存されない」という利用者への説明と矛盾していた
  // 取り込みはホーム画面（SearchScreen）の「まとめて単語帳に取り込む」に一元化した。
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
  // termIdについて、取り込まずに残っている（status:'open'）セッションが既にあれば、それを新規作成
  // せず再開する——ホームの「取り込み待ち」一覧から再度その語を開いた場合や、単語詳細画面で
  // 「この語についてAIに聞く」をもう一度押した場合が該当する。
  // 別の用語のチャットを開いても元のセッションは自動確定しない。「取り込み待ち」一覧に残り続け、
  // 利用者がホーム画面で明示的に取り込むまで開いたままになる。
  async function startChat(termId: string | null, seedQuery: string | null, returnTermId: string | null = null) {
    const existing = termId ? await chatRepo.findOpenSessionByTermId(termId) : undefined;
    const session = existing ?? (await chatRepo.createSession(termId));

    const subject = await buildSubjectContext(termId, seedQuery, { termsRepo, notesRepo });
    setActiveChatSessionId(session.id);
    setScreen({ name: 'chat', sessionId: session.id, subject, returnTermId });
  }

  // ホームの「AIによる単語更新待ち」一覧から、既知のsessionIdでそのまま再開する。
  // startChat()と異なり新規セッションは作らない——用語モードだけでなく自由な質問
  // （termId:null）のセッションも同じ経路で開けるようにするための専用関数。
  async function resumeChatSession(sessionId: string) {
    const session = await chatRepo.getSession(sessionId);
    if (!session) return;
    const subject = await buildSubjectContext(session.termId, null, { termsRepo, notesRepo });
    setActiveChatSessionId(session.id);
    setScreen({ name: 'chat', sessionId: session.id, subject, returnTermId: null });
  }

  // 確定＝AI要約処理・DB書き込み（commitOrchestrator）。完了後、SearchScreenの
  // 「AIによる単語更新待ち」一覧を再取得させるため pendingRefreshTick を進める。
  async function commitSession(sessionId: string): Promise<void> {
    setCommitInProgress(true);
    try {
      // commitOrchestratorのcommit()は失敗時も例外を投げず、内部でonErrorを呼ぶだけで
      // resolveする（src/ai/commitOrchestrator.ts:73-76）。そのため「呼び出し前に楽観的に
      // 失敗マークを消す→失敗すればonErrorが同期的に再セットする」という順序で扱う必要がある
      // （triggerCommitの成否では判定できない）。
      setFailedCommitSessionIds((prev) => {
        if (!prev.has(sessionId)) return prev;
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
      await commitOrchestrator?.triggerCommit(sessionId);
    } finally {
      setCommitInProgress(false);
      setPendingRefreshTick((t) => t + 1);
    }
  }

  // 単語を削除したときの後始末。その語の未取り込みチャットを閉じてから検索画面へ戻す。
  // 閉じないと、ホームの「取り込み待ち」一覧は語が引けないセッションを表示しないため
  // （SearchScreen が termsRepo.getById() で引ける語だけ並べる）、利用者からは見えず
  // 取り込むことも消すこともできない孤児セッションとして残り続ける。
  async function handleTermDeleted(deletedTermId: string) {
    const session = await chatRepo.findOpenSessionByTermId(deletedTermId);
    if (session) {
      await chatRepo.commitSession(session.id);
      if (activeChatSessionId === session.id) setActiveChatSessionId(null);
    }
    setPendingRefreshTick((t) => t + 1);
    setScreen({ name: 'search' });
  }

  // ホーム画面の「取り込み待ち」一覧から取り込む。2026-08-04改訂で、取り込み操作は
  // この経路1つに集約した（チャット画面の「この会話を確定する」と起動時の自動確定を廃止）。
  // 処理はバックグラウンドで進め、押した時点で待たせない。
  function commitPendingTerm(sessionId: string) {
    void commitSession(sessionId);
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
    <div className={ui.rootClassName ? `app ${ui.rootClassName}` : 'app'}>
      <header className="app-header">
        <h1>IT-Index</h1>
        {showBrowserWarning && !browserWarningDismissed && (
          <div className="auth-banner">
            <span>
              このブラウザは対応環境（Android Chrome / PC Chrome・Edge）ではないため、一部機能が正しく動作しない場合があります。
            </span>
            <button type="button" className="btn-text" onClick={() => setBrowserWarningDismissed(true)}>
              閉じる
            </button>
          </div>
        )}
        {hasPersistedKey && !keyReady && (
          <div className="auth-banner">
            <span>保存済みのAPIキーがあります。</span>
            <button type="button" className="btn-primary" onClick={handleAuthenticate} disabled={authenticating}>
              {authenticating ? '認証中…' : 'パスキーで認証'}
            </button>
            <button type="button" className="btn-text" onClick={() => setHasPersistedKey(false)} disabled={authenticating}>
              今は使わない
            </button>
            {authError && <span className="chat-error">{authError}</span>}
          </div>
        )}
      </header>
      <TopNav
        current={topNavCurrent(screen)}
        onGoSearch={() => setScreen({ name: 'search' })}
        onGoHistory={() => setScreen({ name: 'history', view: 'weighted' })}
        onGoIndex={() => setScreen({ name: 'index' })}
        onOpenSettings={() => setScreen({ name: 'settings' })}
        onOpenLink={() => setScreen({ name: 'link' })}
      />
      <main key={screenKey(screen)} className="screen-fade-in">
        {!seedSettled ? null : screen.name === 'search' ? (
          <SearchScreen
            termsRepo={termsRepo}
            chatRepo={chatRepo}
            seedError={seedError}
            seedRefreshTick={seedRefreshTick}
            onRetrySeed={runSeedImport}
            failedCommitSessionIds={failedCommitSessionIds}
            onSelectTerm={handleSelectFromSearch}
            onStartChat={(termId, seedQuery) => void startChat(termId, seedQuery)}
            onResumeChatSession={(sessionId) => void resumeChatSession(sessionId)}
            onCommitPending={commitPendingTerm}
            pendingRefreshTick={pendingRefreshTick}
          />
        ) : screen.name === 'detail' ? (
          <TermDetailScreen
            termId={screen.termId}
            termsRepo={termsRepo}
            notesRepo={notesRepo}
            onBack={() => setScreen({ name: 'search' })}
            onStartChat={(termId) => void startChat(termId, null, termId)}
            onDeleted={(deletedTermId) => void handleTermDeleted(deletedTermId)}
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
            onChangeSubject={(termId) => void startChat(termId, null)}
            onBack={() => {
              // 「確定する」を押さずに離れた場合、自動確定はしない。セッションは open のまま
              // 「AIによる単語更新待ち」一覧に残り、利用者が明示的に確定するまでそのまま残る。
              setScreen({ name: 'search' });
            }}
            onBackToTerm={(termId) => {
              setScreen({ name: 'detail', termId });
            }}
          />
        ) : screen.name === 'history' ? (
          <HistoryScreen
            asksRepo={asksRepo}
            termsRepo={termsRepo}
            initialView={screen.view}
            onSelectTerm={(termId) => setScreen({ name: 'detail', termId })}
            onBack={() => setScreen({ name: 'search' })}
          />
        ) : screen.name === 'index' ? (
          ui.TermIndexScreen && (
            <ui.TermIndexScreen
              termsRepo={termsRepo}
              onSelectTerm={(termId) => setScreen({ name: 'detail', termId })}
            />
          )
        ) : screen.name === 'settings' ? (
          <SettingsModal
            apiKeyStore={apiKeyStore}
            onClose={() => setScreen({ name: 'search' })}
            onCredentialReady={() => setKeyReady(true)}
            autoUpdateExistingTerms={autoUpdateExistingTerms}
            onChangeAutoUpdateExistingTerms={(mode) => {
              setAutoUpdateExistingTerms(mode);
              void settingsRepo.setAutoUpdateExistingTerms(mode);
            }}
          />
        ) : (
          <LinkModal deps={manualSyncDeps} onClose={() => setScreen({ name: 'search' })} />
        )}
      </main>

      <div className="app-toolbar">
        <button
          type="button"
          className="toolbar-btn"
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          aria-label="ライト/ダークモード切り替え"
        >
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
      </div>

      {globalError && <Toast message={globalError} onDismiss={() => setGlobalError(null)} />}
      {!globalError && commitInProgress && (
        <Toast message="確定処理を実行しています…" variant="info" durationMs={15_000} onDismiss={() => {}} />
      )}
      {showOnboarding && <OnboardingModal onClose={dismissOnboarding} />}
    </div>
  );
}
