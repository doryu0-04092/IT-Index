import { useCallback, useEffect, useRef, useState } from 'react';
import type { AiClient } from '../ai/aiClient';
import { sendChatTurn } from '../ai/chat';
import type { CommitOrchestrator } from '../ai/commitOrchestrator';
import { buildQuerySubject, buildSubjectContext, type SubjectContext } from '../ai/subjectContext';
import ChatMessageBody from '../lib/ChatMessageBody';
import type { ChatMessageRecord, ChatSessionRecord } from '../types';
import type { ChatRepository } from '../repositories/chat';
import type { NotesRepository } from '../repositories/notes';
import type { TermsRepository } from '../repositories/terms';
import { ApiRequestError } from '../sync/apiClient';
import { fetchAiQuota } from '../sync/apiClient';
import { getToken } from '../sync/tokenStore';
import { getVerifiedCredential, providerLabel } from '../sync/apiKeyStore';
import TermPicker from './TermPicker';

export interface ChatScreenProps {
  sessionId: string;
  chatRepo: ChatRepository;
  termsRepo: TermsRepository;
  notesRepo: NotesRepository;
  aiClient: AiClient;
  commitOrchestrator: CommitOrchestrator;
  onBack: () => void;
  /** 未ログイン時の案内から同期画面へ誘導する */
  onGoToSync: () => void;
  /**
   * ライセンスが必要(license_required)な場合の案内から設定タブへ誘導する(要件定義書§4)。
   * ChatScreenを直接テストする既存ケースに影響しないよう任意にしてある——未指定時は
   * ボタンを出さないだけで、通常経路(App.tsx)では必ず渡す。
   */
  onGoToSettings?: () => void;
  /**
   * 「話題を変える」で用語を選んだ(移植元: ../../../src/ui/pc/ChatScreen.tsx onChangeSubject。
   * v1のTermPickerをそのまま移植)。呼び出し元(App.tsx)がApp.tsxの既存openChatForTerm
   * (「AIに聞く」と同じ処理)でこの画面のsessionId/subjectを入れ替える。
   */
  onChangeSubject: (termId: string) => void;
  /**
   * 画面を開いた直後に一度だけ自動送信する質問(検索画面の「AIで検索」で入力した文字列。
   * v1(../../../src/ui/pc/ChatScreen.tsx:23-24,106-113)を移植)。新規セッションのときだけ
   * 渡される——既存セッションの再開・リロード復元では渡されないため二重送信は起きない
   * (呼び出し元App.tsxのScreen.initialQuestionがそれを保証する)。
   */
  initialQuestion?: string;
}

// 「単語の概要を聞く」「さらに詳しく聞く」で送る固定文言(v1 ../../../src/ui/pc/ChatScreen.tsx
// から文言をそのまま移植。どの語について話しているかはSubjectContextで確定しているため、
// 文言に語名を埋め込む必要はない——システムプロンプト側で主題を渡してある。ai/prompts.ts)。
const OVERVIEW_QUESTION = 'この用語の基本的な情報を、初心者にもわかるように教えてください。';
const DETAIL_QUESTION = 'ここまでの会話と「理解のために調べたこと」の内容を踏まえて、さらに詳しく教えてください。';

/**
 * AIチャット画面(要件定義書§5.3)。v1(../../../src/ui/pc/ChatScreen.tsx)の核となる挙動
 * ——履歴表示・送信・確定(分配統合)・登録しない——を移植する。v1との最大の差分は
 * AI呼び出し経路(端末からAnthropicを直接呼ばず、必ずv2サーバーのAIプロキシを呼ぶ。
 * docs/v2/requirements.md §4.1)。未ログイン時はこの画面自体がAPIを一切呼ばず、
 * ログイン案内だけを表示する(トークンが無ければAPIを呼ばない、という依頼書の要件)。
 */
export default function ChatScreen({
  sessionId,
  chatRepo,
  termsRepo,
  notesRepo,
  aiClient,
  commitOrchestrator,
  onBack,
  onGoToSync,
  onGoToSettings,
  onChangeSubject,
  initialQuestion,
}: ChatScreenProps) {
  const token = getToken();
  // 自分のキー(接続テスト済み)を使っている間は回数上限の対象外(docs/v2/architecture.md §5)。
  // 残量(/api/ai/quota)はサーバー側キーの残量しか表さないため、取得も表示もしない。
  const ownCredential = getVerifiedCredential();
  const usingOwnApiKey = ownCredential !== null;

  const [session, setSession] = useState<ChatSessionRecord | null | undefined>(undefined);
  const [subject, setSubject] = useState<SubjectContext | undefined>(undefined);
  const [messages, setMessages] = useState<ChatMessageRecord[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  /** 送信失敗が「設定したAPIキーが無効」だった場合のみ、設定画面への誘導を出す */
  const [sendErrorCode, setSendErrorCode] = useState<string | null>(null);
  const [quota, setQuota] = useState<{ used: number; limit: number } | null>(null);
  const [commitState, setCommitState] = useState<'idle' | 'committing' | 'committed' | 'error'>('idle');
  const [commitErrorMessage, setCommitErrorMessage] = useState<string | null>(null);
  // 「話題を変える」用のピッカー開閉(移植元: ../../../src/ui/pc/ChatScreen.tsx pickerOpen)。
  const [pickerOpen, setPickerOpen] = useState(false);
  // initialQuestionの二重送信防止(v1 ../../../src/ui/pc/ChatScreen.tsx:106)。StrictModeの
  // 二重effect実行・再レンダリング両方に効かせるため、stateではなくrefで持つ。
  const initialQuestionSent = useRef(false);

  const reloadMessages = useCallback(async () => {
    setMessages(await chatRepo.getMessages(sessionId));
  }, [chatRepo, sessionId]);

  useEffect(() => {
    if (!token) return; // 未ログイン時はAPIもDBの主題解決も不要(ガード表示のみ)
    // アンマウント後(画面遷移・テスト終了によるDBクローズ)に読み込みが解決・失敗しても
    // 反映しない。catchが無いとDexieのDatabaseClosedErrorが未処理例外になる。
    let cancelled = false;
    void chatRepo
      .getSession(sessionId)
      .then(async (s) => {
        if (cancelled) return;
        setSession(s ?? null);
        if (!s) return;
        if (s.termId) {
          const subjectContext = await buildSubjectContext(s.termId, { termsRepo, notesRepo });
          if (cancelled) return;
          setSubject(subjectContext ?? undefined);
        } else if (s.subjectLabel) {
          setSubject(buildQuerySubject(s.subjectLabel));
        }
        await reloadMessages();
      })
      .catch(() => {
        if (!cancelled) setSession(null);
      });
    return () => {
      cancelled = true;
    };
  }, [token, chatRepo, sessionId, termsRepo, notesRepo, reloadMessages]);

  useEffect(() => {
    if (!token || usingOwnApiKey) return;
    void fetchAiQuota(token)
      .then(setQuota)
      .catch(() => {
        /* 残量表示は付加情報のため、取得失敗時は無表示にするだけで良い */
      });
  }, [token, usingOwnApiKey]);

  // 検索画面の「AIで検索」から来た場合、打った文字列を最初の質問として1回だけ自動送信する
  // (v1 ../../../src/ui/pc/ChatScreen.tsx:102-113を移植)。sessionが読み込まれる(=セッション取得
  // ・主題解決が済む)前に送ると、subjectが未確定のままAI呼び出しへ渡ってしまうため待つ。
  // 既に取り込み済み(committed)のセッションを再送で再開した場合はApp.tsx側でinitialQuestionを
  // 渡さないため、ここでは呼び出し元の保証に従うだけでよい。
  useEffect(() => {
    if (!token || !session || !initialQuestion || initialQuestionSent.current) return;
    initialQuestionSent.current = true;
    void handleSend(initialQuestion);
    // handleSendは毎レンダリング作り直されるため依存に入れない(入れると送信のたびに再実行される)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, session, initialQuestion]);

  if (!token) {
    return (
      <div className="chat-screen chat-screen-guard">
        <button type="button" className="back-link" onClick={onBack}>
          ← 戻る
        </button>
        <p className="status-text">AIチャットにはログインが必要です。</p>
        <button type="button" className="btn-primary" onClick={onGoToSync}>
          同期画面へ
        </button>
      </div>
    );
  }

  async function handleSend(overrideText?: string, hideQuestion?: boolean) {
    const text = (overrideText ?? draft).trim();
    if (text === '' || sending) return;
    setSending(true);
    setSendError(null);
    setSendErrorCode(null);
    if (overrideText === undefined) setDraft('');
    try {
      await sendChatTurn(sessionId, text, { chatRepo, aiClient, subject }, hideQuestion);
      await reloadMessages();
    } catch (err) {
      setSendError(err instanceof ApiRequestError ? err.message : 'AIとの通信に失敗しました');
      setSendErrorCode(err instanceof ApiRequestError ? err.code : null);
      if (overrideText === undefined) setDraft(text); // 送信できなかった内容を戻す
    } finally {
      setSending(false);
    }
  }

  async function handleCommit() {
    setCommitState('committing');
    setCommitErrorMessage(null);
    await commitOrchestrator.triggerCommit(sessionId);
    const updated = await chatRepo.getSession(sessionId);
    if (updated?.status === 'committed') {
      setCommitState('committed');
    } else {
      setCommitState('error');
      setCommitErrorMessage('取り込みに失敗しました。もう一度お試しください。');
    }
  }

  async function handleDecline() {
    await chatRepo.declineSession(sessionId);
    onBack();
  }

  const subjectLabel = subject?.label ?? session?.subjectLabel ?? '';
  const visibleMessages = messages.filter((m) => !m.hidden);

  return (
    <div className="chat-screen">
      <div className="chat-top-row">
        <button type="button" className="back-link" onClick={onBack}>
          ← 戻る
        </button>
        {subjectLabel && <h2 className="chat-subject">{subjectLabel}について</h2>}
        {ownCredential ? (
          <span className="status-text chat-quota">
            自分のAPIキーを使用中({providerLabel(ownCredential.provider)}・回数上限なし)
          </span>
        ) : (
          quota && (
            <span className="status-text chat-quota">
              本日の利用: {quota.used}/{quota.limit}
            </span>
          )
        )}
      </div>

      {session === undefined && <p className="status-text">読み込み中です…</p>}
      {session === null && <p className="status-text">このチャットは見つかりませんでした。</p>}

      {session && (
        <>
          <ul className="chat-messages" aria-label="チャット履歴">
            {visibleMessages.map((m) => (
              <li key={m.id} className={`chat-message chat-message-${m.role}`}>
                <span className="chat-message-role">{m.role === 'user' ? 'あなた' : 'AI'}</span>
                {m.role === 'assistant' ? (
                  <div className="chat-message-content">
                    <ChatMessageBody content={m.content} />
                  </div>
                ) : (
                  <p className="chat-message-content">{m.content}</p>
                )}
              </li>
            ))}
            {/* 送信中スピナー(移植元: ../../../src/ui/pc/ChatScreen.tsx:168-172の
                .chat-loading/.chat-spinner。AIの応答を待っている間だけ表示する) */}
            {sending && (
              <li className="chat-message chat-message-assistant chat-loading">
                <span className="chat-spinner" aria-label="AIが返答を作成中" />
              </li>
            )}
          </ul>

          {sendError && sendErrorCode !== 'license_required' && <p className="error-text">{sendError}</p>}
          {sendErrorCode === 'user_api_key_invalid' && (
            <button type="button" className="btn-secondary" onClick={onGoToSync}>
              設定画面へ
            </button>
          )}
          {/* 公式ホストでライセンスが無い場合、サーバーは403 license_requiredを返す
              (docs/v2/architecture.md §4・§5)。設定タブへ誘導する(既存のuser_api_key_invalid
              誘導と同じ流儀)。 */}
          {sendErrorCode === 'license_required' && onGoToSettings && (
            <div className="chat-license-required">
              <p className="error-text">
                ライセンスが必要です。設定タブから購入(モック)するか、自分のサーバーを設定してください。
              </p>
              <button type="button" className="btn-secondary" onClick={onGoToSettings}>
                設定タブへ
              </button>
            </div>
          )}

          <div className="chat-quick-asks">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void handleSend(OVERVIEW_QUESTION, true)}
              disabled={sending}
            >
              単語の概要を聞く
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void handleSend(DETAIL_QUESTION, true)}
              disabled={sending}
            >
              さらに詳しく聞く
            </button>
          </div>

          {/* 話題を変える(移植元: ../../../src/ui/pc/ChatScreen.tsx:201-204のTermPicker導線)。
              選んだ語で呼び出し元(App.tsx)がこの画面のsessionId/subjectを入れ替える。 */}
          <div className="chat-subject-row">
            <button type="button" className="btn-text chat-subject-change" onClick={() => setPickerOpen(true)}>
              話題を変える
            </button>
          </div>

          <form
            className="chat-input-row"
            onSubmit={(e) => {
              e.preventDefault();
              void handleSend(undefined, false);
            }}
          >
            <label htmlFor="chat-input">メッセージ</label>
            <textarea
              id="chat-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // 日本語入力(IME)で漢字変換を確定するときもEnterキーが飛んでくる。
                // isComposingを見ずに判定すると、文章を書き終える前に変換確定のたびに
                // 送信されてしまう(v1 #4で実機報告された不具合。
                // ../../../src/ui/pc/ChatScreen.tsx:184-192を移植)。変換中のEnterは無視する。
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void handleSend(undefined, false);
                }
              }}
              disabled={sending}
              rows={3}
              placeholder="質問を入力(Enterで送信、Shift+Enterで改行)"
            />
            <button type="submit" className="btn-primary" disabled={sending || draft.trim() === ''}>
              {sending ? '送信中…' : '送信'}
            </button>
          </form>

          <div className="chat-commit-row">
            {commitState !== 'committed' && (
              <>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => void handleCommit()}
                  disabled={commitState === 'committing'}
                >
                  {commitState === 'committing' ? '取り込んでいます…' : 'この会話を取り込む'}
                </button>
                <button
                  type="button"
                  className="btn-danger"
                  onClick={() => void handleDecline()}
                  disabled={commitState === 'committing'}
                >
                  登録しない
                </button>
              </>
            )}
            {commitState === 'committed' && <p className="status-text">取り込みました。</p>}
            {commitState === 'error' && commitErrorMessage && <p className="error-text">{commitErrorMessage}</p>}
          </div>
        </>
      )}

      {pickerOpen && (
        <TermPicker
          termsRepo={termsRepo}
          onSelect={(termId) => {
            setPickerOpen(false);
            onChangeSubject(termId);
          }}
          onCancel={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
