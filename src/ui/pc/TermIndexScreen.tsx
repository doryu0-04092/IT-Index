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

function sectionId(bucket: string): string {
  return `term-index-section-${encodeURIComponent(bucket)}`;
}

/**
 * 「単語一覧」（索引）画面。A〜Z・カタカナの五十音（ア〜ワ）で頭文字ごとに全語を分類し、
 * 1ページ内のジャンプで該当行へ移動できるようにする（バケット分類は src/core/kanaRow.ts）。
 * 該当する語が0件のバケットも見出しだけは表示する——索引としての一覧性を保つため。
 *
 * ジャンプは `<a href="#...">` ではなく `scrollIntoView` で行う。このアプリはURLルーティングを
 * 持たず、戻るボタンでの白紙化を防ぐため画面遷移のたびにダミーのhistoryエントリを積み、
 * popstateで検索画面へ戻すハックが入っている（App.tsx）。`#`リンクへの同一ページ内遷移も
 * ブラウザの同一ドキュメントナビゲーションとしてpopstateを発火させてしまい、
 * このハックに割り込まれて検索画面に戻ってしまう不具合が実際に起きたため、
 * URL・historyに一切触れないこの方式にした。
 */
export default function TermIndexScreen({ termsRepo, onSelectTerm }: TermIndexScreenProps) {
  const [buckets, setBuckets] = useState<Map<string, TermRecord[]> | null>(null);

  useEffect(() => {
    termsRepo.getAll().then((terms) => setBuckets(groupIntoBuckets(terms)));
  }, [termsRepo]);

  function jumpTo(bucket: string) {
    document.getElementById(sectionId(bucket))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <div className="term-index">
      <nav className="term-index-jump" aria-label="頭文字へジャンプ">
        {LATIN_BUCKETS.map((b) => (
          <button key={b} type="button" className="term-index-jump-link" onClick={() => jumpTo(b)}>
            {b}
          </button>
        ))}
      </nav>
      <nav className="term-index-jump" aria-label="五十音へジャンプ">
        {KANA_BUCKETS.map((b) => (
          <button key={b} type="button" className="term-index-jump-link" onClick={() => jumpTo(b)}>
            {b}
          </button>
        ))}
      </nav>

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
    </div>
  );
}
