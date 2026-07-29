import { useEffect, useMemo, useState } from 'react';
import { createDynamicAiClient } from './ai/providers';
import { createCommitOrchestrator } from './ai/commitOrchestrator';
import type { DistributionProposal } from './ai/distribution';
import { logAiError } from './ai/logError';
import { buildSubjectContext, type SubjectContext } from './ai/subjectContext';
import { db } from './db';
import { createApiKeyStore, getSessionCredential } from './keystore/apiKeyStore';
import { createBrowserWebAuthnClient } from './keystore/webauthn';
import { createAsksRepository } from './repositories/asks';
import { createChatRepository } from './repositories/chat';
import { createKeyStoreRepository } from './repositories/keyStore';
import { createNotesRepository } from './repositories/notes';
import { createSettingsRepository } from './repositories/settings';
import { createTermsRepository } from './repositories/terms';
import { fetchSeedFile, importSeed } from './seedImport';
import ApprovalScreen from './ui/pc/ApprovalScreen';
import ChatScreen from './ui/pc/ChatScreen';
import HistoryScreen, { type HistoryView } from './ui/pc/HistoryScreen';
import SearchScreen from './ui/pc/SearchScreen';
import SettingsModal from './ui/pc/SettingsModal';
import TermDetailScreen from './ui/pc/TermDetailScreen';

type Screen =
  | { name: 'search' }
  | { name: 'detail'; termId: string }
  | { name: 'chat'; sessionId: string; subject: SubjectContext }
  | { name: 'approve'; proposal: DistributionProposal }
  | { name: 'history'; view: HistoryView };

export default function App() {
  const [seedStatus, setSeedStatus] = useState('シードを確認中…');
  const [seedSettled, setSeedSettled] = useState(false);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>({ name: 'search' });
  const [activeChatSessionId, setActiveChatSessionId] = useState<string | null>(null);
  const [hasPersistedKey, setHasPersistedKey] = useState(false);
  const [keyReady, setKeyReady] = useState(() => getSessionCredential() !== null);
  const [authenticating, setAuthenticating] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const termsRepo = useMemo(() => createTermsRepository(db), []);
  const notesRepo = useMemo(() => createNotesRepository(db), []);
  const asksRepo = useMemo(() => createAsksRepository(db), []);
  const chatRepo = useMemo(() => createChatRepository(db), []);
  const keyStoreRepo = useMemo(() => createKeyStoreRepository(db), []);
  const webauthn = useMemo(() => createBrowserWebAuthnClient(), []);
  const apiKeyStore = useMemo(() => createApiKeyStore(keyStoreRepo, webauthn), [keyStoreRepo, webauthn]);
  const claude = useMemo(() => createDynamicAiClient(getSessionCredential), []);

  const commitOrchestrator = useMemo(
    () =>
      createCommitOrchestrator({
        chatRepo,
        termsRepo,
        notesRepo,
        claude,
        asksRepo,
        deviceId,
        onProposalReady: (proposal) => setScreen({ name: 'approve', proposal }),
        onError: (sessionId, error) => {
          logAiError(`commitOrchestrator(session=${sessionId})`, error);
          setGlobalError(`確定処理に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
        },
      }),
    [chatRepo, termsRepo, notesRepo, claude, asksRepo, deviceId],
  );

  useEffect(() => {
    const settingsRepo = createSettingsRepository(db);

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

    settingsRepo.get().then((s) => setDeviceId(s.deviceId));
  }, [termsRepo]);

  useEffect(() => {
    return () => commitOrchestrator.dispose();
  }, [commitOrchestrator]);

  useEffect(() => {
    // トリガー④: 起動時に、放置されたままのチャットセッションを回収する。
    // APIキーの認証（keyReady）が済むまでは実行しない——認証前に試みると、
    // 単に「まだキーが無い」だけなのに「APIキーが設定されていません」という
    // 紛らわしい失敗表示が出てしまう（実際に報告された不具合）。
    if (!keyReady) return;
    commitOrchestrator.recoverStaleSessions();
  }, [commitOrchestrator, keyReady]);

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
  async function startChat(termId: string | null, seedQuery: string | null) {
    if (activeChatSessionId) {
      void commitOrchestrator.triggerCommit(activeChatSessionId);
    }
    const subject = await buildSubjectContext(termId, seedQuery, { termsRepo, notesRepo });
    const session = await chatRepo.createSession(termId);
    setActiveChatSessionId(session.id);
    setScreen({ name: 'chat', sessionId: session.id, subject });
  }

  // トリガー③（明示的な確定操作）。確定処理（AI呼び出し）はバックグラウンドで進め、
  // クリックした時点でローカル検索画面へ戻す——確定結果を待たせない（2026-07-29）。
  // 分配案が用意できたら onProposalReady が承認画面へ遷移させるので、その時点で
  // どの画面にいても割り込む形になる。activeChatSessionId はここで解除しておかないと、
  // 次に別のチャットを始めたときにこの（既に確定処理へ回した）セッションへもう一度
  // トリガー①がかかってしまう（実害は無い＝冪等だが、無駄なAI呼び出しになる）。
  function commitAndReturnToSearch(sessionId: string) {
    void commitOrchestrator.triggerCommit(sessionId);
    setActiveChatSessionId(null);
    setScreen({ name: 'search' });
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
            seedStatus={seedStatus}
            onSelectTerm={handleSelectFromSearch}
            onStartChat={(termId, seedQuery) => void startChat(termId, seedQuery)}
            onOpenHistory={(view) => setScreen({ name: 'history', view })}
          />
        ) : screen.name === 'detail' ? (
          <TermDetailScreen
            termId={screen.termId}
            termsRepo={termsRepo}
            notesRepo={notesRepo}
            onBack={() => setScreen({ name: 'search' })}
            onStartChat={(termId) => void startChat(termId, null)}
          />
        ) : screen.name === 'chat' ? (
          <ChatScreen
            sessionId={screen.sessionId}
            subject={screen.subject}
            chatRepo={chatRepo}
            termsRepo={termsRepo}
            claude={claude}
            apiKeyStore={apiKeyStore}
            keyReady={keyReady}
            onKeyReady={() => setKeyReady(true)}
            onCommit={commitAndReturnToSearch}
            onChangeSubject={(termId) => void startChat(termId, null)}
            onBack={() => setScreen({ name: 'search' })}
          />
        ) : screen.name === 'approve' ? (
          deviceId && (
            <ApprovalScreen
              proposal={screen.proposal}
              termsRepo={termsRepo}
              notesRepo={notesRepo}
              asksRepo={asksRepo}
              chatRepo={chatRepo}
              deviceId={deviceId}
              onDone={() => {
                setActiveChatSessionId(null);
                setScreen({ name: 'search' });
              }}
            />
          )
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
        />
      )}
    </div>
  );
}
