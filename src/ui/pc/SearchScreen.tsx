import { useEffect, useMemo, useState } from 'react';
import { score } from '../../core/score';
import type { TermsRepository } from '../../repositories/terms';
import type { TermRecord } from '../../types';
import { useDebouncedValue } from '../shared/useDebouncedValue';

const MAX_RESULTS = 30;

export interface SearchScreenProps {
  termsRepo: TermsRepository;
  onSelectTerm: (termId: string) => void;
  /** 検索欄に入力していた語を渡す。用語詳細画面からのチャット開始と同じ文脈付与に使う */
  onStartChat: (query: string) => void;
  onOpenHistory: (view: 'weighted' | 'timeline') => void;
  /** シード取り込み状況（例: 「最新です（3510語）」）。検索欄の直下に表示する */
  seedStatus: string;
}

export default function SearchScreen({ termsRepo, onSelectTerm, onStartChat, onOpenHistory, seedStatus }: SearchScreenProps) {
  const [terms, setTerms] = useState<TermRecord[]>([]);
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 150);

  useEffect(() => {
    termsRepo.getAll().then(setTerms);
  }, [termsRepo]);

  const results = useMemo(() => {
    if (debouncedQuery.trim() === '') return [];
    return score(debouncedQuery, terms)
      .filter((r) => r.score > 0)
      .slice(0, MAX_RESULTS);
  }, [debouncedQuery, terms]);

  return (
    <div className="search-screen">
      <nav className="search-nav">
        <button type="button" onClick={() => onOpenHistory('weighted')}>
          重み付けビュー
        </button>
        <button type="button" onClick={() => onOpenHistory('timeline')}>
          時系列ビュー
        </button>
      </nav>

      <input
        type="text"
        className="search-input"
        placeholder="用語を入力（かな・カタカナ・英字どれでも）"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />

      <p className="search-status">{seedStatus}</p>
      {terms.length === 0 && <p className="search-status">辞書を読み込み中です…</p>}

      {/*
        要件定義書§5.1: スコアリングは何かしら返すため「候補ゼロ」は構造的にほぼ発生しない
        （長いクエリほど、3510語のどれかと部分一致するため）。よって [AIに聞く] は
        「結果が0件のときだけ出す」のではなく、クエリがある間は常に出しておく
        （「求める語が無かったらここを押す」という導線として）。
      */}
      {debouncedQuery.trim() !== '' && terms.length > 0 && (
        <div className="search-ai-hint">
          <button type="button" onClick={() => onStartChat(query)}>
            求める語が見つからない場合 → AIに聞く
          </button>
        </div>
      )}

      <ul className="search-results">
        {results.map(({ term, score: s }) => (
          <li key={term.id}>
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
