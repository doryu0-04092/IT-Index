import { useEffect, useState } from 'react';
import { BUCKET_ORDER, GOJUON_GRID, groupIntoBuckets, NUMERIC_BUCKET, OTHER_BUCKET, type TermRecord } from '@it-index/shared';
import type { TermsRepository } from '../repositories/terms';

export interface TermIndexScreenProps {
  termsRepo: TermsRepository;
  onSelectTerm: (termId: string) => void;
}

const LATIN_BUCKETS = BUCKET_ORDER.filter((b) => /^[A-Z]$/.test(b));

function sectionId(bucket: string): string {
  return `term-index-section-${encodeURIComponent(bucket)}`;
}

/**
 * 「単語一覧」(索引)画面。v1(../../../src/ui/pc/TermIndexScreen.tsx)から、頭文字バケット分類
 * (BUCKET_ORDER/groupIntoBuckets、@it-index/shared)による一覧表示・3ブロック構成のジャンプ
 * (英字/五十音図/数字・その他)・「一番上へ戻る」ボタンを移植する。分類そのもの
 * (bucketOf/bucketsOf/groupIntoBuckets)はv1と同じ純関数を使うため、語がどのバケットに
 * 入るかの判定結果はv1と変わらない。
 *
 * 並びは英字→かな→数字→その他。「その他」はどのバケットにも分類できなかった語の受け皿で、
 * 本来は空であるべき例外用のため、該当が1件も無いうちはリンク・見出しとも出さない
 * (hasOther/visibleBuckets)。
 *
 * ジャンプは`scrollIntoView`(behavior:'auto'=瞬時移動)で行う。語数が多く縦に長いページのため、
 * スムーズスクロールだと遠くのバケットへの移動に時間がかかりすぎる(v1でのユーザー指摘)。
 * 「一番上へ戻る」ボタンも同様に瞬時移動にする。
 *
 * 各バケットの`<ul>`は検索結果の`.result-list`(max-height:70vhの個別スクロール)ではなく
 * 専用の`.term-index-list`(個別スクロールなし)を使う。索引はページ全体のスクロールに
 * 一本化しないと、ジャンプで動かしたスクロール位置がバケット内に残ってしまう
 * (本人指摘の不具合)。
 */
export default function TermIndexScreen({ termsRepo, onSelectTerm }: TermIndexScreenProps) {
  const [buckets, setBuckets] = useState<Map<string, TermRecord[]> | null>(null);

  useEffect(() => {
    void termsRepo.getAll().then((terms) => setBuckets(groupIntoBuckets(terms)));
  }, [termsRepo]);

  const hasOther = (buckets?.get(OTHER_BUCKET)?.length ?? 0) > 0;
  const visibleBuckets = hasOther ? BUCKET_ORDER : BUCKET_ORDER.filter((b) => b !== OTHER_BUCKET);

  function jumpTo(bucket: string) {
    document.getElementById(sectionId(bucket))?.scrollIntoView({ behavior: 'auto', block: 'start' });
  }

  function scrollToTop() {
    window.scrollTo({ top: 0, behavior: 'auto' });
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
      <nav className="term-index-jump" aria-label="数字・その他へジャンプ">
        <button type="button" className="term-index-jump-link" onClick={() => jumpTo(NUMERIC_BUCKET)}>
          {NUMERIC_BUCKET}
        </button>
        {hasOther && (
          <button type="button" className="term-index-jump-link" onClick={() => jumpTo(OTHER_BUCKET)}>
            {OTHER_BUCKET}
          </button>
        )}
      </nav>

      {buckets === null ? (
        <p className="status-text">読み込み中です…</p>
      ) : (
        visibleBuckets.map((b) => (
          <section key={b} id={sectionId(b)} className="term-index-section">
            <h3 className="term-index-heading">{b}</h3>
            {buckets.get(b)!.length === 0 ? (
              <p className="status-text">該当する語はありません。</p>
            ) : (
              <ul className="term-index-list">
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
