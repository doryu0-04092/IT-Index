import { useEffect, useMemo, useState } from 'react';
import { score } from '../../core/score';
import type { TermsRepository } from '../../repositories/terms';
import Sheet from './Sheet';
import type { TermRecord } from '../../types';

const MAX_RESULTS = 20;

export interface TermPickerProps {
  termsRepo: TermsRepository;
  /** 話題を変える先の用語を選んだ */
  onSelect: (termId: string) => void;
  onCancel: () => void;
}

/**
 * 「話題を変える」で使う、話題にする用語を明示的に選ぶための小さなピッカー（Android版）。
 * 検索画面と同じ score() を再利用する（要件定義書§5.3「利用者が明示的に選ぶ」）。
 * 最上位候補への自動選択はしない——利用者が一覧からタップした語だけを結果とする。
 */
export default function TermPicker({ termsRepo, onSelect, onCancel }: TermPickerProps) {
  const [terms, setTerms] = useState<TermRecord[]>([]);
  const [query, setQuery] = useState('');

  useEffect(() => {
    termsRepo.getAll().then(setTerms);
  }, [termsRepo]);

  const results = useMemo(() => {
    if (query.trim() === '') return [];
    return score(query, terms)
      .filter((r) => r.score > 0)
      .slice(0, MAX_RESULTS);
  }, [query, terms]);

  return (
    <Sheet title="話題にする用語を選ぶ" onClose={onCancel}>
      <div className="term-picker">
        <input
          type="text"
          className="search-input"
          placeholder="用語を入力"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          /* autoFocus は付けない（SearchScreen と同じ理由）。シートを開いた直後に
             キーボードが出ると、選ぼうとしている用語の一覧が隠れてしまう。 */
        />
        <ul className="search-results">
          {results.map(({ term }) => (
            <li key={term.id}>
              <button type="button" className="search-result" onClick={() => onSelect(term.id)}>
                <span className="search-result-term">{term.term}</span>
                <span className="search-result-reading">{term.readings[0]}</span>
                <span className="search-result-field">{term.field}</span>
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="term-picker-cancel btn-secondary btn-block" onClick={onCancel}>
          キャンセル
        </button>
      </div>
    </Sheet>
  );
}
