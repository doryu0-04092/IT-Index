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
import TermPicker from './TermPicker';

export interface ChatScreenProps {
  sessionId: string;
  subject: SubjectContext;
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
  /** 確定処理（バックグラウンド起動）と、ローカル検索画面への遷移の両方を行う。呼び出し元（App）の責務 */
  onCommit: (sessionId: string) => void;
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
  keyReady,
  onKeyReady,
  onCommit,
  onChangeSubject,
  onBack,
}: ChatScreenProps) {
  const [messages, setMessages] = useState<ChatMessageRecord[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  function handleCommit() {
    // 確定処理（AI呼び出し）はバックグラウンドで進み、クリックした時点でローカル検索画面へ
    // 戻る（App.tsx の commitAndReturnToSearch）。成否のフィードバックはこの画面のローカル
    // 状態ではなく既存のグローバルな経路に委ねる: 成功時は commitOrchestrator の
    // onProposalReady が承認画面へ遷移させ、失敗時は onError が App.tsx の globalError に表示する。
    onCommit(sessionId);
  }

  if (!keyReady) {
    return <ApiKeyPrompt apiKeyStore={apiKeyStore} onSet={onKeyReady} onBack={onBack} />;
  }

  return (
    <div className="chat-screen">
      <button type="button" className="term-detail-back" onClick={onBack}>
        ← 検索に戻る
      </button>

      <div className="chat-subject-chip">
        {subject.mode === 'term' ? (
          <span>「{subject.label}」について質問中</span>
        ) : (
          <span>自由な質問{subject.seedQuery ? `（検索語: ${subject.seedQuery}）` : ''}</span>
        )}
      </div>

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

      <button type="button" className="chat-subject-change" onClick={() => setPickerOpen(true)}>
        {subject.mode === 'term' ? '話題を変える' : '用語を選ぶ'}
      </button>

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

      <button type="button" className="chat-commit-button" onClick={handleCommit} disabled={messages.length === 0}>
        この会話を確定する
      </button>
    </div>
  );
}
