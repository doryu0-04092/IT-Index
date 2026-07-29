import { useEffect, useState } from 'react';
import type { AiClient } from '../../ai/aiClient';
import { sendChatTurn } from '../../ai/chat';
import { logAiError } from '../../ai/logError';
import type { SubjectContext } from '../../ai/subjectContext';
import type { ApiKeyStore } from '../../keystore/apiKeyStore';
import { getSessionCredential } from '../../keystore/apiKeyStore';
import type { ChatRepository } from '../../repositories/chat';
import type { TermsRepository } from '../../repositories/terms';
import type { ChatMessageRecord } from '../../types';
import ApiKeyPrompt from './ApiKeyPrompt';
import TermPicker from './TermPicker';

export interface ChatScreenProps {
  sessionId: string;
  subject: SubjectContext;
  chatRepo: ChatRepository;
  termsRepo: TermsRepository;
  claude: AiClient;
  apiKeyStore: ApiKeyStore;
  onCommit: (sessionId: string) => Promise<void>;
  /** 「話題を変える」で用語を選んだ。トリガー①相当（自動確定してから新しい話題で続ける）は呼び出し元（App）の責務 */
  onChangeSubject: (termId: string) => void;
  onBack: () => void;
}

export default function ChatScreen({
  sessionId,
  subject,
  chatRepo,
  termsRepo,
  claude,
  apiKeyStore,
  onCommit,
  onChangeSubject,
  onBack,
}: ChatScreenProps) {
  const [messages, setMessages] = useState<ChatMessageRecord[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasKey, setHasKey] = useState(() => getSessionCredential() !== null);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    chatRepo.getMessages(sessionId).then(setMessages);
  }, [sessionId, chatRepo]);

  async function handleSend() {
    if (input.trim() === '') return;
    const text = input;
    setInput('');
    setSending(true);
    setError(null);
    try {
      await sendChatTurn(sessionId, text, { chatRepo, claude, subject });
    } catch (err) {
      logAiError('ChatScreen.handleSend', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      // sendChatTurn は失敗時もユーザーの発言自体はDBへ保存済みのため
      // （src/ai/chat.ts: appendMessage→claude.send の順）、成否に関わらず
      // 画面を最新状態に合わせる。ここを try 内だけに限定すると、失敗時に
      // 送信したはずのメッセージが画面から消えて見える（実機検証で発見した実バグ）。
      setMessages(await chatRepo.getMessages(sessionId));
      setSending(false);
    }
  }

  async function handleCommit() {
    setCommitting(true);
    setError(null);
    try {
      await onCommit(sessionId);
      // 成功時は親（App）が分配案の受け取りコールバック経由で承認画面へ遷移させる
    } catch (err) {
      logAiError('ChatScreen.handleCommit', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCommitting(false);
    }
  }

  if (!hasKey) {
    return <ApiKeyPrompt apiKeyStore={apiKeyStore} onSet={() => setHasKey(true)} onBack={onBack} />;
  }

  return (
    <div className="chat-screen">
      <button type="button" className="term-detail-back" onClick={onBack}>
        ← 検索に戻る
      </button>

      <div className="chat-subject-chip">
        {subject.mode === 'term' ? (
          <>
            <span>「{subject.label}」について質問中</span>
            <button type="button" className="chat-subject-change" onClick={() => setPickerOpen(true)}>
              話題を変える
            </button>
          </>
        ) : (
          <span className="chat-subject-free">
            自由な質問{subject.seedQuery ? `（検索語: ${subject.seedQuery}）` : ''}
            <button type="button" className="chat-subject-change" onClick={() => setPickerOpen(true)}>
              用語を選ぶ
            </button>
          </span>
        )}
      </div>

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

      <div className="chat-messages">
        {messages.map((m) => (
          <div key={m.id} className={`chat-message chat-message-${m.role}`}>
            <p>{m.content}</p>
          </div>
        ))}
        {messages.length === 0 && <p className="search-status">何でも聞いてください。</p>}
      </div>

      {error && <p className="chat-error">{error}</p>}

      <div className="chat-input-row">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // 日本語入力（IME）で漢字変換を確定するときもEnterキーが飛んでくる。
            // isComposing を見ずに判定すると、文章を書き終える前に変換確定のたびに
            // 送信されてしまう（実際に報告された不具合）。変換中のEnterは無視する。
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="質問を入力（Enterで送信、Shift+Enterで改行）"
          disabled={sending}
        />
        <button type="button" onClick={handleSend} disabled={sending || input.trim() === ''}>
          {sending ? '送信中…' : '送信'}
        </button>
      </div>

      <button
        type="button"
        className="chat-commit-button"
        onClick={handleCommit}
        disabled={committing || messages.length === 0}
      >
        {committing ? '確定処理中…' : 'この会話を確定する'}
      </button>
    </div>
  );
}
