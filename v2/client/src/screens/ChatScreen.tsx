import { useCallback, useEffect, useState } from 'react';
import type { AiClient } from '../ai/aiClient';
import { sendChatTurn } from '../ai/chat';
import type { CommitOrchestrator } from '../ai/commitOrchestrator';
import { buildQuerySubject, buildSubjectContext, type SubjectContext } from '../ai/subjectContext';
import type { ChatMessageRecord, ChatSessionRecord } from '../types';
import type { ChatRepository } from '../repositories/chat';
import type { NotesRepository } from '../repositories/notes';
import type { TermsRepository } from '../repositories/terms';
import { ApiRequestError } from '../sync/apiClient';
import { fetchAiQuota } from '../sync/apiClient';
import { getToken } from '../sync/tokenStore';
import { getVerifiedCredential, providerLabel } from '../sync/apiKeyStore';

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

  const reloadMessages = useCallback(async () => {
    setMessages(await chatRepo.getMessages(sessionId));
  }, [chatRepo, sessionId]);

  useEffect(() => {
    if (!token) return; // 未ログイン時はAPIもDBの主題解決も不要(ガード表示のみ)
    void chatRepo.getSession(sessionId).then(async (s) => {
      setSession(s ?? null);
      if (!s) return;
      if (s.termId) {
        setSubject((await buildSubjectContext(s.termId, { termsRepo, notesRepo })) ?? undefined);
      } else if (s.subjectLabel) {
        setSubject(buildQuerySubject(s.subjectLabel));
      }
      await reloadMessages();
    });
  }, [token, chatRepo, sessionId, termsRepo, notesRepo, reloadMessages]);

  useEffect(() => {
    if (!token || usingOwnApiKey) return;
    void fetchAiQuota(token)
      .then(setQuota)
      .catch(() => {
        /* 残量表示は付加情報のため、取得失敗時は無表示にするだけで良い */
      });
  }, [token, usingOwnApiKey]);

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
                <p className="chat-message-content">{m.content}</p>
              </li>
            ))}
          </ul>

          {sendError && <p className="error-text">{sendError}</p>}
          {sendErrorCode === 'user_api_key_invalid' && (
            <button type="button" className="btn-secondary" onClick={onGoToSync}>
              設定画面へ
            </button>
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
              disabled={sending}
              rows={3}
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
                  className="btn-secondary"
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
    </div>
  );
}
