import { useEffect, useState } from 'react';
import type { AiClient } from '../../ai/aiClient';
import { sendChatTurn } from '../../ai/chat';
import { logAiError } from '../../ai/logError';
import type { SubjectContext } from '../../ai/subjectContext';
import type { ApiKeyStore } from '../../keystore/apiKeyStore';
import type { ChatRepository } from '../../repositories/chat';
import type { TermsRepository } from '../../repositories/terms';
import type { ChatMessageRecord } from '../../types';
import ApiKeyPrompt from './ApiKeyPrompt';
import FeatureHint from './FeatureHint';
import TermPicker from './TermPicker';

export interface ChatScreenProps {
  sessionId: string;
  subject: SubjectContext;
  /** 単語詳細画面の「この語についてAIに聞く」から来た場合のみ、その単語のtermId。それ以外はnull */
  returnTermId: string | null;
  chatRepo: ChatRepository;
  termsRepo: TermsRepository;
  claude: AiClient;
  apiKeyStore: ApiKeyStore;
  /**
   * APIキーが使える状態か。App.tsx が単一の真実源として持つ状態をそのまま受け取る
   * （このコンポーネント自身ではローカルに保持しない）。
   * 以前は `hasKey` をこの画面専用のローカル状態として別に持っていたため、画面を開いたまま
   * 別経路（ヘッダーのバナー・設定モーダル）で認証すると、そちらは「登録済み」と表示されるのに
   * この画面だけ古い状態のまま「APIキーが必要です」を表示し続ける不具合があった
   * （実際に報告された不具合）。
   */
  keyReady: boolean;
  /** この画面内でAPIキーが（初めて、または再度）使えるようになったときに呼ぶ。App.tsx側のkeyReadyを更新する */
  onKeyReady: () => void;
  /** 「話題を変える」で用語を選んだ。トリガー①相当（自動確定してから新しい話題で続ける）は呼び出し元（App）の責務 */
  onChangeSubject: (termId: string) => void;
  onBack: () => void;
  /** returnTermIdが非nullの時だけ表示するリンクから呼ばれる。元の単語詳細画面へ戻る */
  onBackToTerm: (termId: string) => void;
}

export default function ChatScreen({
  sessionId,
  subject,
  returnTermId,
  chatRepo,
  termsRepo,
  claude,
  apiKeyStore,
  keyReady,
  onKeyReady,
  onChangeSubject,
  onBack,
  onBackToTerm,
}: ChatScreenProps) {
  const [messages, setMessages] = useState<ChatMessageRecord[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    chatRepo.getMessages(sessionId).then(setMessages);
  }, [sessionId, chatRepo]);

  async function handleSend(overrideText?: string, hideQuestion?: boolean) {
    const text = overrideText ?? input;
    if (text.trim() === '') return;
    if (overrideText === undefined) setInput('');
    setSending(true);
    setError(null);
    try {
      await sendChatTurn(sessionId, text, { chatRepo, claude, subject }, hideQuestion);
    } catch (err) {
      logAiError('ChatScreen.handleSend', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      // sendChatTurn は失敗時もユーザーの発言自体はDBへ保存済みのため
      // （src/ai/chat.ts: appendMessage→claude.send の順）、成否に関わらず
      // 画面を最新状態に合わせる。ここを try 内だけに限定すると、失敗時に
      // 送信したはずのメッセージが画面から消えて見える（実機検証で発見した実バグ）。
      const updated = await chatRepo.getMessages(sessionId);
      setMessages(updated);
      setSending(false);
    }
  }

  // 「単語の概要を聞く」「さらに詳しく聞く」で送る固定文言。どの語について話しているかは
  // SubjectContext で確定しているため（自由モードは廃止済み）、文言に語名を埋め込む必要はない
  // ——システムプロンプト側で主題を渡してある（src/ai/prompts.ts）。
  const OVERVIEW_QUESTION = 'この用語の基本的な情報を、初心者にもわかるように教えてください。';
  const DETAIL_QUESTION = 'ここまでの会話と「理解のために調べたこと」の内容を踏まえて、さらに詳しく教えてください。';

  if (!keyReady) {
    return <ApiKeyPrompt apiKeyStore={apiKeyStore} onSet={onKeyReady} onBack={onBack} />;
  }

  const visibleMessages = messages.filter((m) => !m.hidden);

  return (
    <div className="chat-screen">
      <button type="button" className="term-detail-back" onClick={onBack}>
        ← 検索に戻る
      </button>

      {returnTermId && (
        <button type="button" className="chat-back-to-term" onClick={() => onBackToTerm(returnTermId)}>
          ← 「{subject.label}」の詳細に戻る
        </button>
      )}

      <div className="chat-subject-chip">
        <span>「{subject.label}」について質問中</span>
      </div>

      <FeatureHint hintKey="chat-quick-asks">
        「概要を聞く」「さらに詳しく聞く」を押すと、よくある質問を自分で入力せずに送れます。
      </FeatureHint>

      <div className="chat-quick-asks">
        <button type="button" className="btn-secondary" onClick={() => handleSend(OVERVIEW_QUESTION, true)} disabled={sending}>
          単語の概要を聞く
        </button>
        <button type="button" className="btn-secondary" onClick={() => handleSend(DETAIL_QUESTION, true)} disabled={sending}>
          さらに詳しく聞く
        </button>
      </div>

      <div className="chat-messages">
        {visibleMessages.map((m) => (
          <div key={m.id} className={`chat-message chat-message-${m.role}`}>
            <p>{m.content}</p>
          </div>
        ))}
        {sending && (
          <div className="chat-message chat-message-assistant chat-loading">
            <span className="chat-spinner" aria-label="AIが返答を作成中" />
          </div>
        )}
        {visibleMessages.length === 0 && !sending && <p className="search-status">何でも聞いてください。</p>}
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
        <button type="button" className="btn-primary" onClick={() => handleSend()} disabled={sending || input.trim() === ''}>
          {sending ? '送信中…' : '送信'}
        </button>
      </div>

      <div className="chat-subject-row">
        <button type="button" className="chat-subject-change btn-text" onClick={() => setPickerOpen(true)}>
          {subject.mode === 'term' ? '話題を変える' : '用語を選ぶ'}
        </button>
        <button
          type="button"
          className="chat-subject-change btn-text"
          onClick={() => handleSend(DETAIL_QUESTION, true)}
          disabled={sending}
        >
          さらに詳しく聞く
        </button>
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
    </div>
  );
}
