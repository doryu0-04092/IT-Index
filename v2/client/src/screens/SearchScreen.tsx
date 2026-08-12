import { useEffect, useMemo, useRef, useState } from 'react';
import { score, type TermRecord } from '@it-index/shared';
import { NO_ACTIVE_INDEX, nextActiveIndex } from '../lib/activeIndex';
import { loadSessionLabelRows, type SessionLabelRow } from '../lib/chatSessionLabels';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import type { ChatRepository } from '../repositories/chat';
import type { TermsRepository } from '../repositories/terms';

const MAX_RESULTS = 30;

export type PendingSession = SessionLabelRow;

export interface SearchScreenProps {
  termsRepo: TermsRepository;
  chatRepo: ChatRepository;
  onSelectTerm: (termId: string) => void;
  /** 検索欄の入力文字列そのものを主題にしてAIに聞く(要件定義書§5.3「検索モード」) */
  onAskAi: (query: string) => void;
  /** 「取り込み待ち」一覧からチャットへ戻る */
  onResumeChat: (sessionId: string) => void;
  /**
   * 「取り込み待ち」一覧から、チャット画面を開かずその場で単語帳へ取り込む
   * (v1 ../../../src/ui/pc/SearchScreen.tsx:224-254を移植)。未ログイン時の誘導は
   * 呼び出し元(App.tsx)の責務——ここではボタンが押されたことだけを伝える。
   */
  onCommitPending: (sessionId: string) => void;
  /**
   * 「登録しない」。AIの判定に登録可否を委ねず、利用者が明示的に拒否できるようにする
   * (v1同機能を移植)。会話は削除しない——ローカル操作のみのためログイン不要。
   */
  onDeclineSession: (sessionId: string) => void;
  /** 前回の取り込みに失敗したセッションIDの集合。一覧に失敗マークを表示するために使う */
  failedCommitSessionIds: Set<string>;
  /**
   * この画面の外でセッションの状態が変わった度に増分する(取り込みの完了等)。
   * 一覧の再取得トリガー。このコンポーネント自身の操作(取り込み・登録しないボタン)では
   * 上がらない——そちらは直接stateを更新するので不要。
   */
  pendingRefreshTick: number;
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
  onCommitPending,
  onDeclineSession,
  failedCommitSessionIds,
  pendingRefreshTick,
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

  // 取り込み待ち(status:'open')セッション一覧(v1 ../../../src/ui/pc/SearchScreen.tsx:86-111を
  // 移植)。「登録しない」を選んだ(declined)セッションはここには出さない——履歴タブの
  // 「取り込み履歴」に移した(本人指定「検索機能周りに関してはV1を踏襲」)。この画面は
  // App.tsxの<main key={screenKey(screen)}>により検索へ戻るたびに再マウントされるため
  // 通常は再取得不要だが、この画面を開いたまま(チャット画面へ行かず)取り込み・確定処理が
  // 完了した場合に一覧を追従させるため、pendingRefreshTickも依存に持つ
  // (v1 App.tsxのpendingRefreshTickと同じ役割)。
  useEffect(() => {
    let cancelled = false;
    void chatRepo.getOpenSessions().then(async (sessions) => {
      const rows = await loadSessionLabelRows(chatRepo, termsRepo, sessions);
      if (!cancelled) setPending(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [chatRepo, termsRepo, pendingRefreshTick]);

  // 取り込みはバックグラウンドで進む(App.tsx側)。押した時点でこの一覧からは消してよい
  // ——結果を待たせない(v1 ../../../src/ui/pc/SearchScreen.tsx:114-117を移植)。
  function handleCommitPending(sessionId: string) {
    onCommitPending(sessionId);
    setPending((prev) => prev.filter((p) => p.session.id !== sessionId));
  }

  // 「登録しない」。会話は消えないので、ここでは一覧から消すだけでよい(v1同箇所を移植)。
  function handleDeclineSession(sessionId: string) {
    onDeclineSession(sessionId);
    setPending((prev) => prev.filter((p) => p.session.id !== sessionId));
  }

  // 「まとめて単語帳に取り込む」。個別の「取り込む」も残す——1件だけ入れたい場合があるため
  // (v1 ../../../src/ui/pc/SearchScreen.tsx:125-131を移植)。
  function handleCommitAll() {
    for (const p of pending) onCommitPending(p.session.id);
    setPending([]);
  }

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

      {/*
        入力した文字列そのものをAIに聞く導線。検索欄のすぐ下に置く——辞書に無い語を打った時に
        「見つかりません」で行き止まりにせず、そのままAIへ繋ぐのが狙い(v1
        ../../../src/ui/pc/SearchScreen.tsx:195-204を移植)。主題は検索結果の語ではなく
        **入力した文字列**(デバウンス前のqueryをそのまま使う点もv1と同じ)。
      */}
      {query.trim() !== '' && (
        <button type="button" className="btn-primary btn-block search-ask-ai" onClick={() => onAskAi(query)}>
          「{query.trim()}」をAIで検索
        </button>
      )}

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

      {/*
        検索していない(ホーム)間だけ表示する。確定する前にチャット画面を離れた語がここに並ぶ
        ——クエリを入力した瞬間に通常の検索結果一覧に切り替わる
        (v1 ../../../src/ui/pc/SearchScreen.tsx:218-222を移植)。
      */}
      {debouncedQuery.trim() === '' && pending.length > 0 && (
        <section className="search-pending">
          <h3>単語帳への取り込み待ち({pending.length}件)</h3>
          <button type="button" className="btn-primary btn-block search-pending-commit-all" onClick={handleCommitAll}>
            まとめて単語帳に取り込む({pending.length}件)
          </button>
          <ul>
            {pending.map(({ session, label }) => (
              <li key={session.id} className="search-pending-row">
                <button type="button" className="btn-text search-pending-item" onClick={() => onResumeChat(session.id)}>
                  {label}
                  {failedCommitSessionIds.has(session.id) && (
                    <span className="error-text search-pending-failed">前回の取り込みに失敗しました</span>
                  )}
                </button>
                <button
                  type="button"
                  className="btn-secondary search-pending-commit"
                  onClick={() => handleCommitPending(session.id)}
                >
                  取り込む
                </button>
                <button
                  type="button"
                  className="btn-text search-pending-decline"
                  onClick={() => handleDeclineSession(session.id)}
                >
                  登録しない
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/*
        1件も一致しなかった時に何も出さないと「まだ検索中なのか、壊れているのか」が
        区別できない。行き止まりにはせず、上の「AIで検索」へ繋ぐ一文を添える
        (v1 ../../../src/ui/pc/SearchScreen.tsx:265-269の文言をそのまま移植)。
      */}
      {debouncedQuery.trim() !== '' && results.length === 0 && (
        <p className="status-text" role="status">
          「{debouncedQuery.trim()}」に一致する語は辞書にありませんでした。上の「AIで検索」から質問できます。
        </p>
      )}

      {results.length > 0 && (
        <p className="status-text" role="status">
          {results.length}件{results.length === MAX_RESULTS && '以上'}見つかりました(↑↓キーで選択、Enterで開く)
        </p>
      )}

      <ul className="result-list" id="search-results-listbox" role="listbox" aria-label="検索結果" ref={listRef}>
        {results.map(({ term, score: s }, index) => (
          <li
            key={term.id}
            className="result-row stagger-row"
            role="presentation"
            style={{ '--stagger-index': index } as React.CSSProperties}
          >
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
    </div>
  );
}
