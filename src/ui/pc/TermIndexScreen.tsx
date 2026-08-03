import { useEffect, useState } from 'react';
import { BUCKET_ORDER, groupIntoBuckets } from '../../core/kanaRow';
import type { TermsRepository } from '../../repositories/terms';
import type { TermRecord } from '../../types';

export interface TermIndexScreenProps {
  termsRepo: TermsRepository;
  onSelectTerm: (termId: string) => void;
}

const LATIN_BUCKETS = BUCKET_ORDER.filter((b) => /^[A-Z]$/.test(b));
const KANA_BUCKETS = BUCKET_ORDER.filter((b) => !/^[A-Z]$/.test(b) && b !== '0-9');

/**
 * 「単語一覧」（索引）画面。A〜Z・カタカナの五十音（ア〜ワ）で頭文字ごとに全語を分類し、
 * 1ページ内のアンカージャンプで該当行へ移動できるようにする（バケット分類は src/core/kanaRow.ts）。
 * 該当する語が0件のバケットも見出しだけは表示する——索引としての一覧性を保つため。
 */
export default function TermIndexScreen({ termsRepo, onSelectTerm }: TermIndexScreenProps) {
  const [buckets, setBuckets] = useState<Map<string, TermRecord[]> | null>(null);

  useEffect(() => {
    termsRepo.getAll().then((terms) => setBuckets(groupIntoBuckets(terms)));
  }, [termsRepo]);

  return (
    <div className="term-index">
      <nav className="term-index-jump" aria-label="頭文字へジャンプ">
        {LATIN_BUCKETS.map((b) => (
          <a key={b} href={`#index-${b}`} className="term-index-jump-link">
            {b}
          </a>
        ))}
      </nav>
      <nav className="term-index-jump" aria-label="五十音へジャンプ">
        {KANA_BUCKETS.map((b) => (
          <a key={b} href={`#index-${b}`} className="term-index-jump-link">
            {b}
          </a>
        ))}
      </nav>

      {buckets === null ? (
        <p className="search-status">読み込み中です…</p>
      ) : (
        BUCKET_ORDER.map((b) => (
          <section key={b} id={`index-${b}`} className="term-index-section">
            <h3 className="term-index-heading">{b}</h3>
            {buckets.get(b)!.length === 0 ? (
              <p className="search-status">該当する語はありません。</p>
            ) : (
              <ul className="search-results">
                {buckets.get(b)!.map((term) => (
                  <li key={term.id} className="search-result-row">
                    <button type="button" className="search-result" onClick={() => onSelectTerm(term.id)}>
                      <span className="search-result-term">{term.term}</span>
                      <span className="search-result-reading">{term.readings[0]}</span>
                      <span className="search-result-field">{term.field}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))
      )}
    </div>
  );
}
