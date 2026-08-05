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
 * 「単語一覧」（索引）画面。A〜Z・かな（清音1文字単位。濁点・半濁点・拗音等は清音にまとめる）で
 * 頭文字ごとに全語を分類し、1ページ内のジャンプで該当行へ移動できるようにする
 * （バケット分類は src/core/kanaRow.ts）。該当する語が0件のバケットも見出しだけは表示する
 * ——索引としての一覧性を保つため。かなのジャンプリンクは伝統的な五十音図の形（10列×5行）で表示する。
 *
 * ジャンプは `<a href="#...">` ではなく `scrollIntoView` で行う。このアプリはURLルーティングを
 * 持たず、戻るボタンでの白紙化を防ぐため画面遷移のたびにダミーのhistoryエントリを積み、
 * popstateで検索画面へ戻すハックが入っている（App.tsx）。`#`リンクへの同一ページ内遷移も
 * ブラウザの同一ドキュメントナビゲーションとしてpopstateを発火させてしまい、
 * このハックに割り込まれて検索画面に戻ってしまう不具合が実際に起きたため、
 * URL・historyに一切触れないこの方式にした。
 * また語数が多く縦に長いページのため、スムーズスクロールだと遠くのバケットへの移動に
 * 時間がかかりすぎる（ユーザー指摘）。ジャンプ・トップへ戻るの両方とも瞬時に移動する。
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
