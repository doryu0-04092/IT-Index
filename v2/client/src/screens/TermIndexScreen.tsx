import { useEffect, useState } from 'react';
import { BUCKET_ORDER, groupIntoBuckets, type TermRecord } from '@it-index/shared';
import type { TermsRepository } from '../repositories/terms';

export interface TermIndexScreenProps {
  termsRepo: TermsRepository;
  onSelectTerm: (termId: string) => void;
}

function sectionId(bucket: string): string {
  return `term-index-section-${encodeURIComponent(bucket)}`;
}

/**
 * 「単語一覧」(索引)画面。v1(../../../src/ui/pc/TermIndexScreen.tsx)から、
 * 頭文字バケット分類(BUCKET_ORDER/groupIntoBuckets、@it-index/shared)による一覧表示を移植する。
 * v1にあった五十音図グリッド(GOJUON_GRID)・「その他」バケットの動的な出し分け(OTHER_BUCKET)は
 * どちらもshared/index.tsからexportされておらず(sharedは変更禁止)、
 * BUCKET_ORDERをそのままジャンプリンク・見出しの並びとして使う簡潔な形にする
 * ——分類そのもの(bucketOf/bucketsOf/groupIntoBuckets)はv1と同じ純関数を使うため、
 * 語がどのバケットに入るかの判定結果はv1と変わらない。
 */
export default function TermIndexScreen({ termsRepo, onSelectTerm }: TermIndexScreenProps) {
  const [buckets, setBuckets] = useState<Map<string, TermRecord[]> | null>(null);

  useEffect(() => {
    void termsRepo.getAll().then((terms) => setBuckets(groupIntoBuckets(terms)));
  }, [termsRepo]);

  function jumpTo(bucket: string) {
    document.getElementById(sectionId(bucket))?.scrollIntoView({ behavior: 'auto', block: 'start' });
  }

  return (
    <div className="term-index">
      <nav className="term-index-jump" aria-label="頭文字へジャンプ">
        {BUCKET_ORDER.map((b) => (
          <button key={b} type="button" className="term-index-jump-link" onClick={() => jumpTo(b)}>
            {b}
          </button>
        ))}
      </nav>

      {buckets === null ? (
        <p className="status-text">読み込み中です…</p>
      ) : (
        BUCKET_ORDER.map((b) => (
          <section key={b} id={sectionId(b)} className="term-index-section">
            <h3 className="term-index-heading">{b}</h3>
            {buckets.get(b)!.length === 0 ? (
              <p className="status-text">該当する語はありません。</p>
            ) : (
              <ul className="result-list">
                {buckets.get(b)!.map((term) => (
                  <li key={term.id} className="result-row">
                    <button type="button" className="result-button" onClick={() => onSelectTerm(term.id)}>
                      <span className="result-term">{term.term}</span>
                      <span className="result-reading">{term.readings[0]}</span>
                      <span className="result-field">{term.field}</span>
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
