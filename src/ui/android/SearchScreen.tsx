import { useEffect, useMemo, useState } from 'react';
import { score } from '../../core/score';
import type { ChatRepository } from '../../repositories/chat';
import type { TermsRepository } from '../../repositories/terms';
import type { TermRecord } from '../../types';
import { useDebouncedValue } from '../shared/useDebouncedValue';
import FeatureHint from './FeatureHint';

const MAX_RESULTS = 30;

interface PendingUpdate {
  sessionId: string;
  term: TermRecord;
}

export interface SearchScreenProps {
  termsRepo: TermsRepository;
  chatRepo: ChatRepository;
  onSelectTerm: (termId: string) => void;
  /**
   * AIチャットを開始する。termId を渡すと用語モード（利用者が明示的に選んだ語）、
   * null なら自由モード（seedQuery は参考情報にすぎず、確定した主題ではない）。
   * 最上位検索候補への自動ひも付けはしない（要件定義書§5.3）。
   */
  onStartChat: (termId: string | null, seedQuery: string | null) => void;
  /** 「AIによる単語更新待ち」一覧から再開する。既存の未確定セッションがあればそれを再開する（App.tsx側の責務） */
  onOpenPendingTerm: (termId: string) => void;
  /** 「AIによる単語更新待ち」一覧から、チャット画面を開かずその場で確定する */
  onCommitPending: (sessionId: string) => void;
  onOpenHistory: (view: 'weighted' | 'timeline') => void;
  /** シード取り込み・ローカル取り込みが異常終了した場合のみ渡される。通常時は null */
  seedError: string | null;
  /** シード取り込み（再試行含む）が完了するたびに増分される。termsの再読み込みトリガー */
  seedRefreshTick: number;
  /** シード取り込みを再試行する（App.tsx側のrunSeedImportを呼ぶ） */
  onRetrySeed: () => void;
  /** 前回の確定処理に失敗したセッションIDの集合。一覧に失敗マークを表示するために使う（#41対応） */
  failedCommitSessionIds: Set<string>;
  /**
   * ローカルフォルダ同期がセッションを裏側で自動commitした可能性がある度に増分する
   * （docs/local-data.md §6.1）。このコンポーネント自身の操作（確定ボタン）では上がらない
   * ——そちらは `handleCommitPending` が直接 state を更新するので不要。
   */
  pendingRefreshTick: number;
}

/**
 * 検索画面（Android版）。PC版と同じprops・同じロジック・同じCSSクラス名を使う
 * （見た目を大きく変えない方針。docs/ui-pc.md §1参照）。狭幅での折り返しは
 * `.android-app .search-result-row` 側のCSS（src/index.css 末尾）で対応する。
 */
export default function SearchScreen({
  termsRepo,
  chatRepo,
  onSelectTerm,
  onStartChat,
  onOpenPendingTerm,
  onCommitPending,
  onOpenHistory,
  seedError,
  seedRefreshTick,
  onRetrySeed,
  failedCommitSessionIds,
  pendingRefreshTick,
}: SearchScreenProps) {
  const [terms, setTerms] = useState<TermRecord[]>([]);
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 150);
  const [pendingUpdates, setPendingUpdates] = useState<PendingUpdate[]>([]);

  useEffect(() => {
    termsRepo.getAll().then(setTerms);
  }, [termsRepo, seedRefreshTick]);

  useEffect(() => {
    let cancelled = false;
    async function loadPendingUpdates() {
      const sessions = await chatRepo.getOpenSessions();
      const items: PendingUpdate[] = [];
      for (const session of sessions) {
        if (!session.termId) continue; // 自由な質問はどの単語の更新待ちか特定できないため対象外
        const messages = await chatRepo.getMessages(session.id);
        if (messages.length === 0) continue; // まだ何もやり取りしていないセッションは表示不要
        const term = await termsRepo.getById(session.termId);
        if (term) items.push({ sessionId: session.id, term });
      }
      if (!cancelled) setPendingUpdates(items);
    }
    void loadPendingUpdates();
    return () => {
      cancelled = true;
    };
  }, [chatRepo, termsRepo, pendingRefreshTick]);

  // 確定処理はバックグラウンドで進む（ChatScreenの「この会話を確定する」と同様）。
  // 押した時点でこの一覧からは消してよい——結果を待たせない。
  function handleCommitPending(sessionId: string) {
    onCommitPending(sessionId);
    setPendingUpdates((prev) => prev.filter((p) => p.sessionId !== sessionId));
  }

  const results = useMemo(() => {
    if (debouncedQuery.trim() === '') return [];
    return score(debouncedQuery, terms)
      .filter((r) => r.score > 0)
      .slice(0, MAX_RESULTS);
  }, [debouncedQuery, terms]);

  return (
    <div className="search-screen">
      <nav className="search-nav">
        <button type="button" className="btn-text" onClick={() => onOpenHistory('weighted')}>
          重み付けビュー
        </button>
        <button type="button" className="btn-text" onClick={() => onOpenHistory('timeline')}>
          時系列ビュー
        </button>
      </nav>

      <input
        type="text"
        className="search-input"
        placeholder="用語を入力（かな・カタカナ・英字どれでも）"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        /* autoFocus は付けない。タッチ端末では画面を開いた瞬間にソフトキーボードが
           立ち上がって画面の半分以上を覆い、検索結果も「更新待ち」一覧も見えなくなる。
           入力したい人が検索欄をタップした時点で出れば足りる。 */
      />

      <p className="search-status">
        {terms.length > 0 ? `登録単語数（${terms.length}語）` : seedError ? '辞書の取り込みに失敗しました' : '辞書を読み込み中です…'}
      </p>
      {seedError && (
        <p className="chat-error">
          {seedError}
          <button type="button" className="btn-text" onClick={onRetrySeed}>
            再試行
          </button>
        </p>
      )}

      {/*
        検索していない（ホーム）の間だけ表示する。確定する前にチャット画面を離れた語がここに並ぶ——
        クエリを入力した瞬間に通常の検索結果一覧に切り替わる。
      */}
      {debouncedQuery.trim() === '' && pendingUpdates.length > 0 && (
        <div className="search-pending">
          <h3 className="search-pending-title">AIによる単語更新待ち</h3>
          <FeatureHint hintKey="search-pending">
            AIと会話した内容は自動では保存されません。「確定する」を押すと、その内容がAI補足として保存されます。
          </FeatureHint>
          <ul className="search-pending-list">
            {pendingUpdates.map((p) => (
              <li key={p.sessionId} className="search-result-row">
                <button type="button" className="search-pending-item" onClick={() => onOpenPendingTerm(p.term.id)}>
                  <span className="search-result-term">{p.term.term}</span>
                  <span className="search-result-reading">{p.term.readings[0]}</span>
                  {failedCommitSessionIds.has(p.sessionId) && (
                    <span className="search-pending-failed chat-error">前回の確定に失敗しました</span>
                  )}
                </button>
                <button
                  type="button"
                  className="search-pending-commit btn-secondary"
                  onClick={() => handleCommitPending(p.sessionId)}
                >
                  確定する
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/*
        要件定義書§5.1: スコアリングは何かしら返すため「候補ゼロ」は構造的にほぼ発生しない
        （長いクエリほど、3510語のどれかと部分一致するため）。よって [AIに聞く] は
        「結果が0件のときだけ出す」のではなく、クエリがある間は常に出しておく
        （「求める語が無かったらここを押す」という導線として）。
      */}
      {debouncedQuery.trim() !== '' && terms.length > 0 && (
        <div className="search-ai-hint">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => onStartChat(null, query.trim() === '' ? null : query.trim())}
          >
            求める語が見つからない場合 → AIに聞く（自由な質問）
          </button>
        </div>
      )}

      <ul className="search-results">
        {results.map(({ term, score: s }, index) => (
          <li
            key={term.id}
            className="search-result-row stagger-row"
            style={{ '--stagger-index': Math.min(index, 12) } as React.CSSProperties}
          >
            <button type="button" className="search-result" onClick={() => onSelectTerm(term.id)}>
              <span className="search-result-term">{term.term}</span>
              <span className="search-result-reading">{term.readings[0]}</span>
              <span className="search-result-field">{term.field}</span>
              {import.meta.env.DEV && <span className="search-result-score">{s.toFixed(2)}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
