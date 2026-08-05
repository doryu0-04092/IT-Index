import { useEffect, useState } from 'react';
import { BUCKET_ORDER, GOJUON_GRID, groupIntoBuckets } from '../../core/kanaRow';
import type { TermsRepository } from '../../repositories/terms';
import type { TermRecord } from '../../types';

export interface TermIndexScreenProps {
  termsRepo: TermsRepository;
  onSelectTerm: (termId: string) => void;
  onBack: () => void;
}

const LATIN_BUCKETS = BUCKET_ORDER.filter((b) => /^[A-Z]$/.test(b));

function sectionId(bucket: string): string {
  return `term-index-section-${encodeURIComponent(bucket)}`;
}

/**
 * 「単語一覧」（索引）画面（Android版）。分類ロジック（清音1文字単位のバケット分け、
 * 五十音図の並び）はPC版と共通（`src/core/kanaRow.ts`）で、ここでは表示だけを行う
 * （PC版 `src/ui/pc/TermIndexScreen.tsx` と同じ方針）。ジャンプ・トップへ戻るがURL/historyに
 * 触れず`scrollIntoView`で瞬時に移動する理由もPC版と同じ（このアプリの戻るボタン対策の
 * popstateハックと、`#`リンクが衝突するため）。
 *
 * タップ操作向けの調整（ジャンプリンク・五十音図の各マスを44px以上に広げる等）は
 * `.android-app` スコープのCSS（src/index.css 末尾）で追記する。
 */
export default function TermIndexScreen({ termsRepo, onSelectTerm, onBack }: TermIndexScreenProps) {
  const [buckets, setBuckets] = useState<Map<string, TermRecord[]> | null>(null);

  useEffect(() => {
    termsRepo.getAll().then((terms) => setBuckets(groupIntoBuckets(terms)));
  }, [termsRepo]);

  function jumpTo(bucket: string) {
    document.getElementById(sectionId(bucket))?.scrollIntoView({ behavior: 'auto', block: 'start' });
  }

  function scrollToTop() {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  return (
    <div className="term-index">
      <button type="button" className="term-detail-back" onClick={onBack}>
        ← 検索に戻る
      </button>
      <nav className="term-index-jump" aria-label="頭文字へジャンプ">
        {LATIN_BUCKETS.map((b) => (
          <button key={b} type="button" className="term-index-jump-link" onClick={() => jumpTo(b)}>
            {b}
          </button>
        ))}
      </nav>
      <div className="term-index-gojuon-grid" role="navigation" aria-label="五十音へジャンプ">
        {GOJUON_GRID.map((row, rowIndex) =>
          row.map((b, colIndex) =>
            b === null ? (
              <span key={`${rowIndex}-${colIndex}`} className="term-index-gojuon-blank" aria-hidden="true" />
            ) : (
              <button key={b} type="button" className="term-index-jump-link" onClick={() => jumpTo(b)}>
                {b}
              </button>
            ),
          ),
        )}
      </div>

      {buckets === null ? (
        <p className="search-status">読み込み中です…</p>
      ) : (
        BUCKET_ORDER.map((b) => (
          <section key={b} id={sectionId(b)} className="term-index-section">
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

      <button
        type="button"
        className="term-index-scroll-top"
        onClick={scrollToTop}
        aria-label="一番上へ戻る"
        title="一番上へ戻る"
      >
        ↑
      </button>
    </div>
  );
}
