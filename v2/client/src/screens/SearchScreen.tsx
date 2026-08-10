import { useEffect, useMemo, useRef, useState } from 'react';
import { score, type TermRecord } from '@it-index/shared';
import { NO_ACTIVE_INDEX, nextActiveIndex } from '../lib/activeIndex';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import type { ChatRepository } from '../repositories/chat';
import type { TermsRepository } from '../repositories/terms';
import type { ChatSessionRecord } from '../types';

const MAX_RESULTS = 30;

export interface PendingSession {
  session: ChatSessionRecord;
  /** 表示用の見出し(termIdがあれば辞書側の正式名、無ければsubjectLabel) */
  label: string;
}

export interface SearchScreenProps {
  termsRepo: TermsRepository;
  chatRepo: ChatRepository;
  onSelectTerm: (termId: string) => void;
  /** 検索欄の入力文字列そのものを主題にしてAIに聞く(要件定義書§5.3「検索モード」) */
  onAskAi: (query: string) => void;
  /** 「取り込み待ち」一覧からチャットへ戻る */
  onResumeChat: (sessionId: string) => void;
  /** シード取り込みが異常終了した場合のみ渡される。通常時はnull */
  seedError: string | null;
  /** シード取り込み(再試行含む)が完了するたびに増分される。termsの再読み込みトリガー */
  seedRefreshTick: number;
  /** シード取り込みを再試行する */
  onRetrySeed: () => void;
}

/**
 * 要件定義書§4.1「用語検索」/§5.3「AIチャットと分配統合」。v1(../../../src/ui/pc/
 * SearchScreen.tsx)の「AIで検索」導線と「取り込み待ち」一覧をあわせて移植する。
 * 入力150msデバウンス→normalize+scoreで全件走査・ランキング表示、という核となる動作は
 * v1と同一(purely core/score.tsの呼び出し)。
 */
export default function SearchScreen({
  termsRepo,
  chatRepo,
  onSelectTerm,
  onAskAi,
  onResumeChat,
  seedError,
  seedRefreshTick,
  onRetrySeed,
}: SearchScreenProps) {
  const [terms, setTerms] = useState<TermRecord[]>([]);
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 150);
  const [activeIndex, setActiveIndex] = useState(NO_ACTIVE_INDEX);
  const listRef = useRef<HTMLUListElement>(null);
  const [pending, setPending] = useState<PendingSession[]>([]);

  useEffect(() => {
    void termsRepo.getAll().then(setTerms);
  }, [termsRepo, seedRefreshTick]);

  // 取り込み待ち(open)・登録しなかった(declined)セッション一覧(v1 SearchScreenの「取り込み
  // 待ち」相当)。この画面はApp.tsxの<main key={screenKey(screen)}>により検索へ戻るたびに
  // 再マウントされるため、マウント時の取得だけで最新の状態に追従できる。
  useEffect(() => {
    void chatRepo.getRecentSessions(30).then(async (sessions) => {
      const targets = sessions.filter((s) => s.status === 'open' || s.status === 'declined');
      const withLabels = await Promise.all(
        targets.map(async (session) => {
          const term = session.termId ? await termsRepo.getById(session.termId) : undefined;
          return { session, label: term?.term ?? session.subjectLabel ?? '(不明)' };
        }),
      );
      setPending(withLabels);
    });
  }, [chatRepo, termsRepo]);

  const results = useMemo(() => {
    if (debouncedQuery.trim() === '') return [];
    return score(debouncedQuery, terms)
      .filter((r) => r.score > 0)
      .slice(0, MAX_RESULTS);
  }, [debouncedQuery, terms]);

  useEffect(() => {
    if (activeIndex < 0) return;
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const activeResult = activeIndex >= 0 ? results[activeIndex] : undefined;

  function handleSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      if (activeIndex >= 0) setActiveIndex(NO_ACTIVE_INDEX);
      else if (query !== '') setQuery('');
      return;
    }
    if (results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => nextActiveIndex(i, 'down', results.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => nextActiveIndex(i, 'up', results.length));
    } else if (e.key === 'Enter' && activeResult) {
      e.preventDefault();
      onSelectTerm(activeResult.term.id);
    }
  }

  return (
    <div className="search-screen">
      <input
        type="text"
        className="search-input"
        placeholder="用語を入力(かな・カタカナ・英字どれでも)"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActiveIndex(NO_ACTIVE_INDEX);
        }}
        onKeyDown={handleSearchKeyDown}
        role="combobox"
        aria-expanded={results.length > 0}
        aria-controls="search-results-listbox"
        aria-activedescendant={activeIndex >= 0 ? `search-result-${activeIndex}` : undefined}
        aria-autocomplete="list"
        aria-label="用語を検索"
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
      />

      <p className="status-text">
        {terms.length > 0 ? `登録単語数(${terms.length}語)` : seedError ? '辞書の取り込みに失敗しました' : '辞書を読み込み中です…'}
      </p>
      {seedError && (
        <p className="error-text">
          {seedError}
          <button type="button" className="btn-text" onClick={onRetrySeed}>
            再試行
          </button>
        </p>
      )}

      {debouncedQuery.trim() !== '' && results.length === 0 && (
        <p className="status-text" role="status">
          「{debouncedQuery.trim()}」に一致する語は辞書にありませんでした。
        </p>
      )}

      {debouncedQuery.trim() !== '' && (
        <button type="button" className="btn-text search-ask-ai" onClick={() => onAskAi(debouncedQuery.trim())}>
          「{debouncedQuery.trim()}」についてAIで検索
        </button>
      )}

      {results.length > 0 && (
        <p className="status-text" role="status">
          {results.length}件{results.length === MAX_RESULTS && '以上'}見つかりました(↑↓キーで選択、Enterで開く)
        </p>
      )}

      <ul className="result-list" id="search-results-listbox" role="listbox" aria-label="検索結果" ref={listRef}>
        {results.map(({ term, score: s }, index) => (
          <li key={term.id} className="result-row" role="presentation">
            <button
              type="button"
              id={`search-result-${index}`}
              className={`result-button${index === activeIndex ? ' result-button-active' : ''}`}
              role="option"
              aria-selected={index === activeIndex}
              onClick={() => onSelectTerm(term.id)}
              onMouseEnter={() => setActiveIndex(index)}
              tabIndex={-1}
            >
              <span className="result-term">{term.term}</span>
              <span className="result-reading">{term.readings[0]}</span>
              <span className="result-field">{term.field}</span>
              {import.meta.env.DEV && <span className="result-score">{s.toFixed(2)}</span>}
            </button>
          </li>
        ))}
      </ul>

      {pending.length > 0 && (
        <section className="search-pending">
          <h3>取り込み待ち({pending.length}件)</h3>
          <ul>
            {pending.map(({ session, label }) => (
              <li key={session.id}>
                <button type="button" className="btn-text" onClick={() => onResumeChat(session.id)}>
                  {label}
                  {session.status === 'declined' && '(登録しない、を選択済み)'}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
