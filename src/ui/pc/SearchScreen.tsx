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
  /** 語ひも付きなら見出し語、「AIで検索」なら入力した文字列 */
  label: string;
  /** 語ひも付きの場合のみ。読み仮名 */
  reading: string | null;
}

export interface SearchScreenProps {
  termsRepo: TermsRepository;
  chatRepo: ChatRepository;
  onSelectTerm: (termId: string) => void;
  /**
   * 検索欄に入力した文字列そのものをAIに聞く（2026-08-06追加）。辞書に無い語こそAIに
   * 聞きたいという要望に応えるための導線で、**検索結果の特定の語ではなく入力文字列が主題**になる。
   */
  onAiSearch: (query: string) => void;
  /** 「取り込み待ち」一覧から、そのセッションのチャット画面を開いて再開する */
  onResumeChatSession: (sessionId: string) => void;
  /** 「取り込み待ち」一覧から、チャット画面を開かずその場で単語帳へ取り込む */
  onCommitPending: (sessionId: string) => void;
  /** シード取り込み・ローカル取り込みが異常終了した場合のみ渡される。通常時は null */
  seedError: string | null;
  /** シード取り込み（再試行含む）が完了するたびに増分される。termsの再読み込みトリガー */
  seedRefreshTick: number;
  /** シード取り込みを再試行する（App.tsx側のrunSeedImportを呼ぶ） */
  onRetrySeed: () => void;
  /** 前回の取り込みに失敗したセッションIDの集合。一覧に失敗マークを表示するために使う（#41対応） */
  failedCommitSessionIds: Set<string>;
  /**
   * この画面の外でセッションの状態が変わった度に増分する（取り込みの完了、単語削除に伴う
   * セッションの close 等）。一覧の再取得トリガー。このコンポーネント自身の操作
   * （取り込みボタン）では上がらない——そちらは直接 state を更新するので不要。
   */
  pendingRefreshTick: number;
}

export default function SearchScreen({
  termsRepo,
  chatRepo,
  onSelectTerm,
  onAiSearch,
  onResumeChatSession,
  onCommitPending,
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
        const messages = await chatRepo.getMessages(session.id);
        if (messages.length === 0) continue; // まだ何もやり取りしていないセッションは表示不要

        if (session.termId) {
          const term = await termsRepo.getById(session.termId);
          if (term) items.push({ sessionId: session.id, label: term.term, reading: term.readings[0] ?? null });
        } else if (session.subjectLabel) {
          // 検索欄からの「AIで検索」。辞書の語ではないので読み仮名は無い
          items.push({ sessionId: session.id, label: session.subjectLabel, reading: null });
        }
        // termIdもsubjectLabelも無いのは廃止済みの旧「自由モード」のセッション。
        // 主題を復元できず取り込む対象も決められないため、ここでは出さない。
      }
      if (!cancelled) setPendingUpdates(items);
    }
    void loadPendingUpdates();
    return () => {
      cancelled = true;
    };
  }, [chatRepo, termsRepo, pendingRefreshTick]);

  // 取り込みはバックグラウンドで進む。押した時点でこの一覧からは消してよい——結果を待たせない。
  function handleCommitPending(sessionId: string) {
    onCommitPending(sessionId);
    setPendingUpdates((prev) => prev.filter((p) => p.sessionId !== sessionId));
  }

  // 「まとめて単語帳に取り込む」。チャット画面から確定ボタンを無くし、取り込みの操作を
  // このホーム画面1箇所に集約したため（2026-08-04改訂）、溜まった分を一度に片付けられる
  // 導線をここに置く。個別の「取り込む」も残してある——1件だけ入れたい場合があるため。
  function handleCommitAll() {
    for (const p of pendingUpdates) onCommitPending(p.sessionId);
    setPendingUpdates([]);
  }

  const results = useMemo(() => {
    if (debouncedQuery.trim() === '') return [];
    return score(debouncedQuery, terms)
      .filter((r) => r.score > 0)
      .slice(0, MAX_RESULTS);
  }, [debouncedQuery, terms]);

  return (
    <div className="search-screen">
      <input
        type="text"
        className="search-input"
        placeholder="用語を入力（かな・カタカナ・英字どれでも）"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />

      {/*
        入力した文字列そのものをAIに聞く導線（2026-08-06追加）。検索欄のすぐ下に置く——
        辞書に無い語を打った時に「見つかりません」で行き止まりにせず、そのままAIへ繋ぐのが狙い。
        主題は検索結果の語ではなく**入力した文字列**（src/ai/subjectContext.ts の mode:'query'）。
      */}
      {query.trim() !== '' && (
        <button type="button" className="search-ai-search btn-primary btn-block" onClick={() => onAiSearch(query)}>
          「{query.trim()}」をAIで検索
        </button>
      )}

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
          <h3 className="search-pending-title">単語帳への取り込み待ち（{pendingUpdates.length}件）</h3>
          <FeatureHint hintKey="search-pending">
            AIと会話した内容は自動では保存されません。ここで取り込むと、その内容がAI補足として単語帳に保存されます。
          </FeatureHint>
          <button type="button" className="btn-primary btn-block search-pending-commit-all" onClick={handleCommitAll}>
            まとめて単語帳に取り込む（{pendingUpdates.length}件）
          </button>
          <ul className="search-pending-list">
            {pendingUpdates.map((p) => (
              <li key={p.sessionId} className="search-result-row">
                <button type="button" className="search-pending-item" onClick={() => onResumeChatSession(p.sessionId)}>
                  <span className="search-result-term">{p.label}</span>
                  {p.reading && <span className="search-result-reading">{p.reading}</span>}
                  {failedCommitSessionIds.has(p.sessionId) && (
                    <span className="search-pending-failed chat-error">前回の取り込みに失敗しました</span>
                  )}
                </button>
                <button
                  type="button"
                  className="search-pending-commit btn-secondary"
                  onClick={() => handleCommitPending(p.sessionId)}
                >
                  取り込む
                </button>
              </li>
            ))}
          </ul>
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
