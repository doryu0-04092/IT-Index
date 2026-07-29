import { useEffect, useMemo, useState } from 'react';
import { createDynamicAiClient } from './ai/providers';
import { createCommitOrchestrator } from './ai/commitOrchestrator';
import type { DistributionProposal } from './ai/distribution';
import { logAiError } from './ai/logError';
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
  | { name: 'chat'; sessionId: string; termLabel: string | null }
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
        onProposalReady: (proposal) => setScreen({ name: 'approve', proposal }),
        onError: (sessionId, error) => {
          logAiError(`commitOrchestrator(session=${sessionId})`, error);
          setGlobalError(`確定処理に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
        },
      }),
    [chatRepo, termsRepo, notesRepo, claude],
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

  function startChat(termId: string | null, termLabel: string | null) {
    if (activeChatSessionId) {
      // トリガー①: 別の用語のチャットを開いた＝前の会話は終わり
      void commitOrchestrator.triggerCommit(activeChatSessionId);
    }
    chatRepo.createSession(termId).then((session) => {
      setActiveChatSessionId(session.id);
      setScreen({ name: 'chat', sessionId: session.id, termLabel });
    });
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
            onSelectTerm={(termId) => setScreen({ name: 'detail', termId })}
            onStartChat={(query) => startChat(null, query.trim() === '' ? null : query.trim())}
            onOpenHistory={(view) => setScreen({ name: 'history', view })}
          />
        ) : screen.name === 'detail' ? (
          <TermDetailScreen
            termId={screen.termId}
            termsRepo={termsRepo}
            notesRepo={notesRepo}
            onBack={() => setScreen({ name: 'search' })}
            onStartChat={(termId, termLabel) => startChat(termId, termLabel)}
          />
        ) : screen.name === 'chat' ? (
          <ChatScreen
            sessionId={screen.sessionId}
            termLabel={screen.termLabel}
            chatRepo={chatRepo}
            claude={claude}
            apiKeyStore={apiKeyStore}
            onCommit={(sessionId) => commitOrchestrator.triggerCommit(sessionId)}
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
