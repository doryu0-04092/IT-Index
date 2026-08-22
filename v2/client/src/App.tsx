import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { createProxyAiClient } from './ai/aiClient';
import { createCommitOrchestrator } from './ai/commitOrchestrator';
import { db } from './db';
import Skeleton from './lib/Skeleton';
import OnboardingModal from './lib/OnboardingModal';
import { hasSeenOnboarding, markOnboardingSeen } from './lib/onboarding';
import { applyThemeChoice, persistThemeChoice, readStoredThemeChoice, type ThemeChoice } from './lib/theme';
import Toast from './lib/Toast';
import { screenKey, type Screen } from './navigation';
import { persistScreen, readPersistedScreen } from './screenPersistence';
import ChatScreen from './screens/ChatScreen';
import CheckoutScreen from './screens/CheckoutScreen';
import HistoryScreen from './screens/HistoryScreen';
import SearchScreen from './screens/SearchScreen';
import SettingsScreen from './screens/SettingsScreen';
import SyncScreen from './screens/SyncScreen';
import TermDetailScreen from './screens/TermDetailScreen';
import TermIndexScreen from './screens/TermIndexScreen';
import { purchaseLicense, savePaymentMethod } from './sync/apiClient';
import { runAutoPull, shouldRefreshAfterAutoPull } from './sync/autoPull';
import { retryPendingPush, runAutoPush } from './sync/pendingPush';
import { pushToRelay, type SyncEngineDeps } from './sync/syncEngine';
import { getAccountId, getToken } from './sync/tokenStore';
import { useAppInit } from './useAppInit';

type NavTarget = 'search' | 'index' | 'history' | 'settings' | 'sync';

function navLabel(target: NavTarget): string {
  switch (target) {
    case 'search':
      return '検索';
    case 'index':
      return '索引';
    case 'history':
      return '履歴';
    case 'settings':
      return '設定';
    case 'sync':
      return '同期';
  }
}

/**
 * 統括(画面遷移・DB初期化・シード取り込みのオーケストレーション)を担う。
 * v1のApp.tsx(659行、AI/同期/認証まで抱えて責務が集中していた)を繰り返さないため、
 * DB初期化・シード取り込みはuseAppInit.tsへ、画面遷移の型はnavigation.tsへ分離する
 * (docs/v2/architecture.md §8)。単一レスポンシブUIのため画面はPC/スマホで分けず、
 * ルーターも追加せずstate(Screen)だけで遷移する(要件定義書§4.1)。
 */
export function App() {
  const {
    termsRepo,
    notesRepo,
    asksRepo,
    chatRepo,
    settingsRepo,
    noteConflictsRepo,
    syncEventsRepo,
    syncStateRepo,
    deviceId,
    isNativeApp,
    platformSettled,
    autoUpdateExistingTerms,
    seedError,
    seedSettled,
    seedRefreshTick,
    runSeedImport,
  } = useAppInit();
  const [screen, setScreen] = useState<Screen>({ name: 'search' });
  // リロード時の文脈復元(v1 #39)を一度だけ試みるためのガード。seedSettled後に1回だけ実行する。
  const [screenRestoreAttempted, setScreenRestoreAttempted] = useState(false);
  // 確定に失敗したセッションIDの集合。「取り込み待ち」一覧に失敗マークを表示するために使う
  // (v1 #41を移植)。次に確定に成功したら該当セッションを取り除く。
  const [failedCommitSessionIds, setFailedCommitSessionIds] = useState<Set<string>>(new Set());
  // 取り込み(確定)が完了・失敗するたびに増分する(#167でpendingRefreshTickから一般化)。
  // 検索(語一覧+取り込み待ち)・索引・単語詳細・履歴がこれを依存に持ち、開いたままの画面へ
  // 裏側のデータ差し替えだけで自動反映する(再マウントしないため入力・フォーカスは保たれる)。
  // 増分の起点はcommitOrchestratorのonCommitted/onError——チャット経由・一覧経由の
  // どちらの確定でも同じ通知が飛ぶ。
  const [commitRefreshTick, setCommitRefreshTick] = useState(0);

  // テーマ手動切替(依頼者指定。lib/theme.ts参照)。既定はOS追従('system')——v1(常に明示保存)
  // と異なり、保存が無い初回起動時はOSの設定にそのまま追従させる。
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>(() => readStoredThemeChoice());
  useEffect(() => {
    applyThemeChoice(themeChoice);
    persistThemeChoice(themeChoice);
  }, [themeChoice]);

  // グローバルトースト(依頼者指定。移植元: ../../src/App.tsx:647-655のglobalError/
  // commitInProgress表示。v1は「エラー」と「進行中」の2種を出し分けていたが、ここでは
  // 呼び出し側がvariantを渡す単一スロットに一般化する(同時に複数出す要件はv1にも無い)。
  const [toast, setToast] = useState<{ message: string; variant: 'error' | 'info' } | null>(null);
  const notify = useCallback((message: string, variant: 'error' | 'info' = 'error') => {
    setToast({ message, variant });
  }, []);

  // 辞書取り込み失敗をトースト通知する(依頼者指定。SearchScreen側の常時表示(seedError+再試行
  // ボタン)は残したまま、Toastは一時的な追加通知として重ねる)。useAppInit.tsのrunSeedImportと
  // 同じ理由でawaitを最初に置き、effect内の同期的なsetState呼び出しから切り離す。
  useEffect(() => {
    if (!seedError) return;
    void Promise.resolve().then(() => notify(seedError, 'error'));
  }, [seedError, notify]);

  // オンボーディング(依頼者指定。lib/onboarding.ts参照)。初回起動時のみ表示する。
  const [showOnboarding, setShowOnboarding] = useState(() => !hasSeenOnboarding());
  function dismissOnboarding(dontShowAgain: boolean) {
    if (dontShowAgain) markOnboardingSeen();
    setShowOnboarding(false);
  }

  // URLルーティングを持たないため、画面遷移してもhistoryエントリが増えず、ブラウザの
  // 戻るボタンを押すとアプリの前画面ではなく「流入前のページ」へ即座に離脱し白紙化して
  // いた(v1 #35。../../src/App.tsx:178-204を移植)。画面が変わるたびにダミーのhistory
  // エントリを積み、popstateで検索画面へ戻すことで、少なくとも白紙化は防ぐ。
  // 注記: v1のコメントには「索引ジャンプの#リンクがpopstateを誤発火させる」問題への言及が
  // あったが、v2のTermIndexScreenはdocument.getElementById().scrollIntoView()方式で
  // ジャンプしており`#`リンクを使っていないため、その問題は最初から起きない。
  useEffect(() => {
    window.history.pushState({ appScreen: true }, '');
  }, [screen]);

  useEffect(() => {
    function handlePopState() {
      setScreen({ name: 'search' });
    }
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // リロード時の文脈復元(v1 #39。../../src/screenPersistence.ts・App.tsx:186-195,285-333を
  // 移植)。URLは変えず、sessionStorageに「どの画面にいたか」の識別子だけを保存する。
  // 保存はscreenが変わるたびに行うが、復元(下のuseEffect)が完了する前に保存すると
  // 初期値{name:'search'}で上書きしてしまうため、復元試行が済むまでは保存しない。
  useEffect(() => {
    if (!screenRestoreAttempted) return;
    persistScreen(screen);
  }, [screen, screenRestoreAttempted]);

  // 復元はseedSettled後(=各画面が自分でDBを引き直せる状態)に一度だけ試みる。v1と異なり
  // v2の各画面(ChatScreen/TermDetailScreen)はsessionId/termIdからDBを引き直す設計のため、
  // ここではShape検証済みのScreenをそのままsetScreenするだけでよい(App.tsx側でセッション・
  // 用語の実在確認をする必要が無い——存在しない場合は各画面が「見つかりませんでした」を
  // 表示して安全に振る舞う。screenPersistence.tsのisPersistedScreen参照)。
  useEffect(() => {
    if (!seedSettled || screenRestoreAttempted) return;
    // awaitを最初に置き、setState呼び出しをeffectの同期実行から切り離す
    // (react-hooks/set-state-in-effectが「effect内での同期的なsetState呼び出し」を検出するため。
    // useAppInit.tsのrunSeedImportと同じ対処。1マイクロタスク分の遅延は復元タイミングに影響しない)。
    void Promise.resolve().then(() => {
      setScreenRestoreAttempted(true);
      const persisted = readPersistedScreen();
      if (persisted) setScreen(persisted);
    });
  }, [seedSettled, screenRestoreAttempted]);

  // AI呼び出しは端末からAnthropicを直接呼ばず、必ずv2サーバーのAIプロキシを呼ぶ
  // (docs/v2/requirements.md §4.1)。トークンは呼び出しごとに読み直す(ログイン状態が
  // 変わってもこの参照を作り直す必要が無い。ai/aiClient.ts参照)。
  const aiClient = useMemo(() => createProxyAiClient(getToken), []);

  /**
   * 端末の現在のスナップショットをリレー(Cloudflare)へ自動pushする。
   *
   * 手動の「今すぐ同期」を待たずに変更をリレーへ移しておくためのもので、契機は2つ:
   * - 競合の解消(#169): 相手端末がその時オフラインでも、次の同期で決定を取り込める
   * - 取り込み(確定)の完了(#177): これが無いと、2端末で内容が揃うのに
   *   「端末1で同期 → 端末2で同期 → もう一度端末1で同期」の3回が必要になる
   *   (1回目は相手がまだpushしておらず空振りするため)。取り込み時点でpushしておけば
   *   各端末が1回ずつ同期するだけで揃う。
   *
   * AI APIは使わない(pushはリレーのみで完結する)。
   *
   * write-ahead(#179): pushの前に「push待ち」印を永続化し、成功が確認できた時だけ消す
   * (sync/pendingPush.ts)。失敗・未ログイン・クラッシュでは印が残り、起動時・
   * オンライン復帰時・次の自動push時に再試行される——「上げたつもりの変更がリレーに無い」
   * 状態を残さないため(実行予定フラグの喪失=意図の破損、という本人指定の方針)。
   */
  const pushSnapshotToRelay = useCallback(() => {
    void runAutoPush(settingsRepo, () => {
      const token = getToken();
      const accountId = getAccountId();
      if (!token || !accountId || !deviceId) {
        // 未ログイン等でpush不能: rejectして印を残す(ログイン後の起動時リトライで拾う)。
        // accountIdは同期の暗号鍵を引くために要る(#182。sync/syncKeyStore.ts)
        return Promise.reject(new Error('push不能(未ログインまたはdeviceId未確定)'));
      }
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
      return pushToRelay(deps, token);
    });
  }, [settingsRepo, termsRepo, notesRepo, asksRepo, noteConflictsRepo, syncEventsRepo, syncStateRepo, deviceId, isNativeApp]);

  // push待ちの再試行(#179): 起動時(deviceId確定後)とオンライン復帰時に、残っている
  // 「push待ち」印を拾って再pushする。印はrunAutoPush側で成功時にのみ消える。
  useEffect(() => {
    if (!deviceId) return;
    void retryPendingPush(settingsRepo, pushSnapshotToRelay);
  }, [deviceId, settingsRepo, pushSnapshotToRelay]);

  useEffect(() => {
    const onOnline = () => void retryPendingPush(settingsRepo, pushSnapshotToRelay);
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [settingsRepo, pushSnapshotToRelay]);

  /**
   * 起動時の自動受け取り(#193)。同期は送る側だけが自動で、受け取る側は「今すぐ同期」を
   * 押した時しか走らなかったため、相手が自動pushしていてもこちらへ降りてこず、
   * 片方向にしか進んでいないように見えていた(#182の実機確認で報告された)。
   *
   * **失敗しても画面には出さない**(sync/autoPull.tsのコメント参照)。押していないのに
   * エラーが出るのは筋が通らないため。受信があった時だけ各画面のデータを読み直す。
   */
  const autoPullDone = useRef(false);
  useEffect(() => {
    // **platformSettled を待つ(#217)。** isNativeApp の初期値 false は「PCである」ではなく
    // 「まだ分からない」で、判定は @capacitor/core の動的import(別チャンク)の解決を待つ。
    // deviceId(IndexedDB読み)が先に確定すると、下の ref ガードがその時点で立ってしまい、
    // Androidでも holdLocalOnConflict: false のまま自動pullが走る——そして deps に
    // isNativeApp があっても ref に阻まれて**やり直されない**。false で走ると
    // newest-wins マージになり、この端末のノートが noteHistory に残らないまま
    // 上書きされる(sync/syncEngine.ts の holdLocalOnConflict 分岐 / repositories/notes.ts の
    // upsertFromSync と adoptPeerDecision の違い)。Androidには競合解消UIが無いため戻せない。
    if (!deviceId || !platformSettled || autoPullDone.current) return;
    autoPullDone.current = true; // 起動につき1回だけ(依存の再評価で複数回走らせない)

    const token = getToken();
    const accountId = getAccountId();
    const syncDeps: SyncEngineDeps | null =
      accountId !== null
        ? {
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
          }
        : null;

    void runAutoPull({ token, syncDeps, online: navigator.onLine }).then((outcome) => {
      if (shouldRefreshAfterAutoPull(outcome)) setCommitRefreshTick((t) => t + 1);
    });
  }, [
    deviceId,
    platformSettled,
    termsRepo,
    notesRepo,
    asksRepo,
    noteConflictsRepo,
    syncEventsRepo,
    syncStateRepo,
    isNativeApp,
  ]);

  // 確定オーケストレーション(要件定義書§5.3)。deviceId確定前はAI確定操作自体が起きない
  // (ChatScreenを開くには辞書取り込み・deviceId発行が済んでいる必要がある)ため、
  // deviceIdがnullの間は空文字で仮組みしておく。
  const commitOrchestrator = useMemo(
    () =>
      createCommitOrchestrator({
        db,
        chatRepo,
        termsRepo,
        notesRepo,
        asksRepo,
        settingsRepo,
        aiClient,
        deviceId: deviceId ?? '',
        autoUpdateExistingTerms,
        // 取り込み待ち一覧の失敗マーク用(v1 #41を移植)。AI呼び出し失敗時、状態遷移図どおり
        // セッションはopenのまま残り(commitOrchestrator側でcommitting→openへ戻す)、
        // 次回再試行できる。
        onError: (sessionId) => {
          setFailedCommitSessionIds((prev) => new Set(prev).add(sessionId));
          // 取り込み失敗をトースト通知する(移植元: ../../src/App.tsx:247-250のsetGlobalError。
          // v1準拠——失敗時のみエラートーストを出す)。
          notify('取り込みに失敗しました。もう一度お試しください。', 'error');
          // 失敗でもセッション状態はcommitting→openへ戻っており、一覧表示の追従が要る(#167)
          setCommitRefreshTick((t) => t + 1);
        },
        // 取り込み完了時(#167で画面反映、#177でリレーへの自動push)。チャット経由・
        // 一覧経由のどちらの確定でもここから通知が飛ぶ
        onCommitted: () => {
          setCommitRefreshTick((t) => t + 1);
          pushSnapshotToRelay();
        },
      }),
    [chatRepo, termsRepo, notesRepo, asksRepo, settingsRepo, aiClient, deviceId, autoUpdateExistingTerms, notify, pushSnapshotToRelay],
  );

  // 「AIに聞く」(用語詳細から)。取り込み待ち(open)の既存セッションがあれば再開する。
  // committing中のセッションはfindOpenSessionByTermId('open'限定)にマッチしないため、
  // 自然に新規セッションが立つ(要件定義書§5.3「取り込み中に同じ語を開いた場合は別の新しい
  // セッションが立つ」)。既存openセッションが無い場合はここではまだcreateSessionしない
  // ——「下書き」としてチャット画面を開き、最初の送信が実際に成立する時点(ChatScreen.tsx
  // handleSend)で初めてセッションを作る(本人決定。未ログイン等で送信できないまま戻った
  // 場合に不可視の空セッションが残る問題への対応)。「話題を変える」(onChangeSubject)も
  // この関数を経由するため同じ遅延規則に自然に乗る。
  const openChatForTerm = useCallback(
    async (termId: string, returnTo: Screen) => {
      const existing = await chatRepo.findOpenSessionByTermId(termId);
      if (existing) {
        setScreen({ name: 'chat', sessionId: existing.id, returnTo });
      } else {
        setScreen({ name: 'chat', sessionId: null, termId, subjectLabel: '', returnTo });
      }
    },
    [chatRepo],
  );

  // 「AIで検索」(検索欄の入力文字列をそのまま主題にする。要件定義書§5.3「検索モード」)。
  // 新規(下書きから作られた)セッションのときだけ、打った文字列をそのまま最初の質問として
  // 自動送信する(v1のinitialQuestion方式。../../src/ui/pc/ChatScreen.tsx:23-24,106-113・
  // ../../src/App.tsx startQueryChatを移植)。既存セッションを再開した場合は同じ質問の
  // 二重送信になるため送らない。openChatForTermと同じ理由でcreateSessionはここでは呼ばない
  // ——ChatScreen側が最初の送信成立時に作る。
  const openChatForQuery = useCallback(
    async (query: string) => {
      const existing = await chatRepo.findOpenSessionBySubjectLabel(query);
      if (existing) {
        setScreen({ name: 'chat', sessionId: existing.id, returnTo: { name: 'search' } });
      } else {
        setScreen({
          name: 'chat',
          sessionId: null,
          termId: null,
          subjectLabel: query,
          returnTo: { name: 'search' },
          initialQuestion: query,
        });
      }
    },
    [chatRepo],
  );

  // 検索画面の「取り込み待ち」一覧から、チャット画面を開かずその場で単語帳へ取り込む
  // (v1 ../../src/ui/pc/SearchScreen.tsx:224-254・App.tsx commitPendingTermを移植)。
  // 未ログイン時はAI呼び出しが必要な操作(取り込み)を押した時に同期画面へ誘導する
  // (ChatScreen.tsxの未ログインガードと同じ方針)。
  const commitPendingTerm = useCallback(
    (sessionId: string) => {
      if (!getToken()) {
        setScreen({ name: 'sync' });
        return;
      }
      // 呼び出し前に楽観的に失敗マークを消す→失敗すればcommitOrchestratorのonErrorが
      // 再セットする(v1 App.tsx commitSessionの順序を移植。triggerCommitの成否だけでは
      // 判定できないため)。
      setFailedCommitSessionIds((prev) => {
        if (!prev.has(sessionId)) return prev;
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
      // 一覧の再読込はcommitOrchestratorのonCommitted/onErrorがtickを上げるため、ここでは
      // 行わない(#167。チャット経由の確定と通知経路を1本化した)。
      void commitOrchestrator.triggerCommit(sessionId).then(async () => {
        // 取り込み成功をトースト通知する(依頼者指定。失敗はcommitOrchestratorのonErrorが
        // 既に通知するため、ここでは成功時(status==='committed')だけ判定する)。
        const updated = await chatRepo.getSession(sessionId);
        if (updated?.status === 'committed') notify('取り込みました。', 'info');
      });
    },
    [commitOrchestrator, chatRepo, notify],
  );

  // 「登録しない」。ローカル操作のみでAI呼び出しを伴わないためログイン不要
  // (v1 ../../src/ui/pc/SearchScreen.tsx:119-123・App.tsx declineSessionを移植)。
  const declinePendingSession = useCallback(
    (sessionId: string) => {
      void chatRepo.declineSession(sessionId).then(() => setCommitRefreshTick((t) => t + 1));
    },
    [chatRepo],
  );

  // 要件定義書§4.1「ローカル検索の確定」。検索・索引・履歴のいずれから選んで
  // 単語詳細を開いた場合も「確定」として記録する(v1のApp.tsx openDetail相当。
  // AIチャット確定(source:'ai')より弱い重みで加算される。core/computeWeights.ts)。
  // 戻り先(returnTo)は開いた画面を丸ごと保持する(chatと同じ仕組み。navigation.ts参照)。
  const openDetail = useCallback(
    (termId: string, returnTo: Screen) => {
      if (deviceId) {
        void asksRepo.addSearchConfirm(termId, deviceId, Date.now());
      }
      setScreen({ name: 'detail', termId, returnTo });
    },
    [asksRepo, deviceId],
  );

  function handleTermDeleted() {
    setScreen({ name: 'search' });
  }

  const navCurrent: NavTarget | null =
    screen.name === 'search' ||
    screen.name === 'index' ||
    screen.name === 'history' ||
    screen.name === 'settings' ||
    screen.name === 'sync'
      ? screen.name
      : null;

  return (
    // checkout表示中はタブナビを隠す(App.css .app-checkout-mode。誤タップでの決済フロー
    // 離脱防止+全画面チェックアウトの見た目のため)
    <div className={screen.name === 'checkout' ? 'app app-checkout-mode' : 'app'}>
      {/*
        DOM再構成(依頼者指定): .app-navを.app-headerの外に出し、両者を.app-topでまとめる。
        以前は.app-navが position:sticky の.app-header の子だったため、モバイル幅で
        position:fixed に切り替えたとき、タブバーのラベルがヘッダー位置にも薄く二重描画される
        不具合があった(実機Android WebView。DOMは1つで、ヒットテストにも出ない描画層の複製)。
        .app-header{position:static}やtransform:translateZ(0)では消えず、祖先が
        sticky/transformを持たない状態にしないと解消しなかったため、構造自体を分離する。
        デスクトップ(≥720px)は.app-topごとposition:stickyにして現行の見た目を維持し、
        モバイル(<720px)は.app-topをposition:staticにした上で.app-navだけをfixed bottomにする
        (App.css参照)。
      */}
      <div className="app-top">
        <header className="app-header">
          <h1>IT-Index</h1>
        </header>
        <nav className="app-nav" aria-label="画面切り替え">
          {(['search', 'index', 'history', 'settings', 'sync'] as const).map((target) => (
            <button
              key={target}
              type="button"
              className={navCurrent === target ? 'app-nav-link app-nav-link-active' : 'app-nav-link'}
              onClick={() =>
                setScreen(target === 'history' ? { name: 'history', view: 'timeline' } : ({ name: target } as Screen))
              }
              aria-current={navCurrent === target ? 'page' : undefined}
            >
              {navLabel(target)}
            </button>
          ))}
        </nav>
      </div>

      <main key={screenKey(screen)} className="app-main screen-fade-in">
        {!seedSettled ? (
          <>
            <p className="status-text">辞書を読み込み中です…</p>
            <Skeleton />
          </>
        ) : screen.name === 'search' ? (
          <SearchScreen
            termsRepo={termsRepo}
            chatRepo={chatRepo}
            onSelectTerm={(termId) => openDetail(termId, { name: 'search' })}
            onAskAi={(query) => void openChatForQuery(query)}
            onResumeChat={(sessionId) => setScreen({ name: 'chat', sessionId, returnTo: { name: 'search' } })}
            onCommitPending={commitPendingTerm}
            onDeclineSession={declinePendingSession}
            failedCommitSessionIds={failedCommitSessionIds}
            commitRefreshTick={commitRefreshTick}
            seedError={seedError}
            seedRefreshTick={seedRefreshTick}
            onRetrySeed={() => void runSeedImport()}
          />
        ) : screen.name === 'index' ? (
          <TermIndexScreen
            termsRepo={termsRepo}
            onSelectTerm={(termId) => openDetail(termId, { name: 'index' })}
            commitRefreshTick={commitRefreshTick}
          />
        ) : screen.name === 'history' ? (
          <HistoryScreen
            asksRepo={asksRepo}
            termsRepo={termsRepo}
            chatRepo={chatRepo}
            notesRepo={notesRepo}
            noteConflictsRepo={noteConflictsRepo}
            syncEventsRepo={syncEventsRepo}
            aiClient={aiClient}
            isNativeApp={isNativeApp}
            deviceId={deviceId}
            view={screen.view}
            onChangeView={(view) => setScreen({ name: 'history', view })}
            onSelectTerm={(termId) => openDetail(termId, screen)}
            onOpenChatSession={(sessionId) => setScreen({ name: 'chat', sessionId, returnTo: screen })}
            onCommitPending={commitPendingTerm}
            onGoToSettings={() => setScreen({ name: 'settings' })}
            commitRefreshTick={commitRefreshTick}
            onResolutionApplied={pushSnapshotToRelay}
          />
        ) : screen.name === 'settings' ? (
          <SettingsScreen
            db={db}
            themeChoice={themeChoice}
            onThemeChange={setThemeChoice}
            onGoToSync={() => setScreen({ name: 'sync' })}
            onGoToCheckout={(intent) => setScreen({ name: 'checkout', intent })}
          />
        ) : screen.name === 'checkout' ? (
          <CheckoutScreen
            intent={screen.intent}
            onBack={() => setScreen({ name: 'settings' })}
            processPayment={() => {
              // 未ログインで到達しない導線(設定タブはauthed時のみ購入ボタンを出す)だが、
              // トークン欠落時も画面側の汎用エラー表示に落ちるよう防御的にrejectする
              const token = getToken();
              if (token === null) return Promise.reject(new Error('ログインが必要です'));
              return purchaseLicense(token);
            }}
            savePaymentMethod={async (method) => {
              const token = getToken();
              if (token === null) throw new Error('ログインが必要です');
              await savePaymentMethod(token, method);
            }}
          />
        ) : screen.name === 'sync' ? (
          <SyncScreen
            db={db}
            deviceId={deviceId}
            isNativeApp={isNativeApp}
            termsRepo={termsRepo}
            notesRepo={notesRepo}
            asksRepo={asksRepo}
            noteConflictsRepo={noteConflictsRepo}
            syncEventsRepo={syncEventsRepo}
            syncStateRepo={syncStateRepo}
            aiClient={aiClient}
            onSyncNotify={notify}
            onGoToConflictHistory={() => {
              // 履歴タブの「競合」を直接開く(#225)。競合の経緯は履歴側が正本で、
              // 同期画面には直近の同期に紐づく分しか出ない
              setScreen({ name: 'history', view: 'conflicts' });
            }}
            onSyncApplied={() => setCommitRefreshTick((t) => t + 1)}
            onResolutionApplied={pushSnapshotToRelay}
            onGoToSettings={() => setScreen({ name: 'settings' })}
          />
        ) : screen.name === 'chat' ? (
          <ChatScreen
            sessionId={screen.sessionId}
            termId={screen.sessionId === null ? screen.termId : undefined}
            subjectLabel={screen.sessionId === null ? screen.subjectLabel : undefined}
            chatRepo={chatRepo}
            termsRepo={termsRepo}
            notesRepo={notesRepo}
            aiClient={aiClient}
            commitOrchestrator={commitOrchestrator}
            onBack={() => setScreen(screen.returnTo)}
            onGoToSync={() => setScreen({ name: 'sync' })}
            onGoToSettings={() => setScreen({ name: 'settings' })}
            onChangeSubject={(termId) => void openChatForTerm(termId, screen.returnTo)}
            initialQuestion={screen.initialQuestion}
          />
        ) : (
          <TermDetailScreen
            termId={screen.termId}
            termsRepo={termsRepo}
            notesRepo={notesRepo}
            deviceId={deviceId}
            onBack={() => setScreen(screen.returnTo)}
            onDeleted={handleTermDeleted}
            onOpenChat={(termId) => void openChatForTerm(termId, screen)}
            commitRefreshTick={commitRefreshTick}
          />
        )}
      </main>

      {toast && <Toast message={toast.message} variant={toast.variant} onDismiss={() => setToast(null)} />}
      {showOnboarding && <OnboardingModal onClose={dismissOnboarding} />}
    </div>
  );
}
