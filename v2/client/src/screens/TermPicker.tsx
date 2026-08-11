import { useEffect, useMemo, useState } from 'react';
import { score, type TermRecord } from '@it-index/shared';
import type { TermsRepository } from '../repositories/terms';

const MAX_RESULTS = 20;

export interface TermPickerProps {
  termsRepo: TermsRepository;
  /** 話題を変える先の用語を選んだ */
  onSelect: (termId: string) => void;
  onCancel: () => void;
}

/**
 * 「話題を変える」で使う、話題にする用語を明示的に選ぶための小さなピッカー
 * (移植元: ../../../src/ui/pc/TermPicker.tsx)。検索画面と同じscore()(@it-index/shared)を
 * 再利用する。最上位候補への自動選択はしない——利用者が一覧からクリックした語だけを結果とする
 * (v1準拠)。
 */
export default function TermPicker({ termsRepo, onSelect, onCancel }: TermPickerProps) {
  const [terms, setTerms] = useState<TermRecord[]>([]);
  const [query, setQuery] = useState('');

  useEffect(() => {
    void termsRepo.getAll().then(setTerms);
  }, [termsRepo]);

  const results = useMemo(() => {
    if (query.trim() === '') return [];
    return score(query, terms)
      .filter((r) => r.score > 0)
      .slice(0, MAX_RESULTS);
  }, [query, terms]);

  return (
    <div className="modal-overlay">
      <div className="modal-content term-picker">
        <div className="modal-header">
          <h2>話題にする用語を選ぶ</h2>
        </div>
        <input
          type="text"
          className="search-input"
          placeholder="用語を入力"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          // 用語を選ぶことだけが目的のモーダルのため、開いた時点で検索欄へフォーカスを移す(v1準拠)。
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
        />
        <ul className="result-list">
          {results.map(({ term }) => (
            <li key={term.id} className="result-row">
              <button type="button" className="result-button" onClick={() => onSelect(term.id)}>
                <span className="result-term">{term.term}</span>
                <span className="result-reading">{term.readings[0]}</span>
                <span className="result-field">{term.field}</span>
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="btn-secondary btn-block" onClick={onCancel}>
          キャンセル
        </button>
      </div>
    </div>
  );
}
