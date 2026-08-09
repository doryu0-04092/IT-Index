import { useEffect, useMemo, useRef, useState } from 'react';
import { score } from '../../core/score';
import type { ChatRepository } from '../../repositories/chat';
import type { TermsRepository } from '../../repositories/terms';
import type { TermRecord } from '../../types';
import { NO_ACTIVE_INDEX, nextActiveIndex } from '../shared/activeIndex';
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
  /**
   * 「登録しない」（2026-08-06追加）。AIの判定に登録可否を委ねず、利用者が明示的に
   * 拒否できるようにするための操作。会話は削除しない——履歴画面の「取り込み履歴」タブに
   * 残り、後から取り込み直せる（データが消えるわけではないため確認は1回のクリックのみ）。
   */
  onDeclineSession: (sessionId: string) => void;
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
  onDeclineSession,
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
  /**
   * キーボードで選択中の検索結果（NO_ACTIVE_INDEX は未選択）。この画面の主動線は
   * 「打つ → 選ぶ → 開く」で、マウスに持ち替えずに完結できる必要がある（2026-08-09追加）。
   * フォーカス自体は入力欄に残したまま aria-activedescendant で選択位置を伝える
   * combobox パターンを採る——矢印キーで移動しても続けて絞り込みを打てるようにするため。
   */
  const [activeIndex, setActiveIndex] = useState(NO_ACTIVE_INDEX);
  const listRef = useRef<HTMLUListElement>(null);

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

  // 「登録しない」。会話は消えず「取り込み履歴」タブに残るので、ここでは一覧から消すだけでよい。
  function handleDeclineSession(sessionId: string) {
    onDeclineSession(sessionId);
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

  // 選択位置を画面内に保つ。DOM操作のみで state を触らないため effect でよい。
  useEffect(() => {
    if (activeIndex < 0) return;
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const activeResult = activeIndex >= 0 ? results[activeIndex] : undefined;

  function handleSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      // 1段階ずつ戻す: 選択中なら選択解除、選択が無ければ入力を消す
      if (activeIndex >= 0) setActiveIndex(NO_ACTIVE_INDEX);
      else if (query !== '') setQuery('');
      return;
    }
    if (results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault(); // 入力欄のカーソル移動を止める
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
        placeholder="用語を入力（かな・カタカナ・英字どれでも）"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActiveIndex(NO_ACTIVE_INDEX); // 絞り込みが変われば選択位置は無効
        }}
        onKeyDown={handleSearchKeyDown}
        role="combobox"
        aria-expanded={results.length > 0}
        aria-controls="search-results-listbox"
        // 見出し語IDは空白や記号を含みうる（例: "tcp/ip"）。aria-activedescendant は
        // 単一IDしか取れないため、位置の連番で参照して壊れないようにする。
        aria-activedescendant={activeIndex >= 0 ? `search-result-${activeIndex}` : undefined}
        aria-autocomplete="list"
        aria-label="用語を検索"
        // この画面はアプリを開いた直後の入り口で、目的は検索そのもの。
        // 起動のたびに入力欄を押させないため autoFocus を意図的に残す。
        // eslint-disable-next-line jsx-a11y/no-autofocus
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
                <button
                  type="button"
                  className="search-pending-decline btn-text"
                  onClick={() => handleDeclineSession(p.sessionId)}
                >
                  登録しない
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/*
        1件も一致しなかった時に何も出さないと「まだ検索中なのか、壊れているのか」が
        区別できない。行き止まりにはせず、上の「AIで検索」へ繋ぐ一文を添える（2026-08-09追加）。
      */}
      {debouncedQuery.trim() !== '' && results.length === 0 && (
        <p className="search-empty" role="status">
          「{debouncedQuery.trim()}」に一致する語は辞書にありませんでした。上の「AIで検索」から質問できます。
        </p>
      )}

      {results.length > 0 && (
        <p className="search-result-count" role="status">
          {results.length}件{results.length === MAX_RESULTS && '以上'}見つかりました（↑↓キーで選択、Enterで開く）
        </p>
      )}

      <ul className="search-results" id="search-results-listbox" role="listbox" aria-label="検索結果" ref={listRef}>
        {results.map(({ term, score: s }, index) => (
          <li
            key={term.id}
            className="search-result-row stagger-row"
            style={{ '--stagger-index': Math.min(index, 12) } as React.CSSProperties}
            role="presentation"
          >
            <button
              type="button"
              id={`search-result-${index}`}
              className={`search-result${index === activeIndex ? ' search-result-active' : ''}`}
              role="option"
              aria-selected={index === activeIndex}
              onClick={() => onSelectTerm(term.id)}
              onMouseEnter={() => setActiveIndex(index)}
              tabIndex={-1}
            >
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
