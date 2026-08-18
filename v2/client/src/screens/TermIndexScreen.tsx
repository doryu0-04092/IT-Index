import { useEffect, useRef, useState } from 'react';
import { BUCKET_ORDER, GOJUON_GRID, groupIntoBuckets, NUMERIC_BUCKET, OTHER_BUCKET, type Bucket, type TermRecord } from '@it-index/shared';
import type { TermsRepository } from '../repositories/terms';

export interface TermIndexScreenProps {
  termsRepo: TermsRepository;
  onSelectTerm: (termId: string) => void;
}

const LATIN_BUCKETS = BUCKET_ORDER.filter((b) => /^[A-Z]$/.test(b));

/**
 * 段階描画のチャンク幅(#135)。索引は全語(3500語超)を並べるため、一度にDOMへ入れると
 * 挿入直後のスタイル計算だけで実測約1秒メインスレッドが止まる(2026-08-18、本番ビルド・
 * PC・CPU等倍。CSSのcontent-visibilityはレイアウトは省略できてもこのスタイル計算は
 * 省略できないことを実測で確認済み)。そこで最初のコミットでは先頭セクションだけを
 * 描画して即座に画面を出し、残りはrequestAnimationFrameで1フレーム1チャンクずつ追加して
 * 1フレームあたりのスタイル計算を小さく保つ。6セクション≒平均300行前後で、
 * 1チャンクの処理が数十ms程度に収まる見積もり。
 */
const SECTIONS_PER_CHUNK = 6;

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
 * セクションは段階描画する(#135。SECTIONS_PER_CHUNKのコメント参照)。未描画のセクションへ
 * ジャンプされた場合は、そのセクションまでを一度に描画してから(pendingJumpRef)スクロールする。
 *
 * ジャンプは`scrollIntoView`(behavior:'auto'=瞬時移動)で行う。語数が多く縦に長いページのため、
 * スムーズスクロールだと遠くのバケットへの移動に時間がかかりすぎる(v1でのユーザー指摘)。
 * 「一番上へ戻る」ボタンも同様に瞬時移動にする。着地後にもう一度だけ補正スクロールを行う
 * ——content-visibility(App.css .term-index-section)の仮高さ由来で、初回の着地位置が
 * 実レイアウト確定後に数行ずれることがあるため。
 *
 * 各バケットの`<ul>`は検索結果の`.result-list`(max-height:70vhの個別スクロール)ではなく
 * 専用の`.term-index-list`(個別スクロールなし)を使う。索引はページ全体のスクロールに
 * 一本化しないと、ジャンプで動かしたスクロール位置がバケット内に残ってしまう
 * (本人指摘の不具合)。
 */
export default function TermIndexScreen({ termsRepo, onSelectTerm }: TermIndexScreenProps) {
  const [buckets, setBuckets] = useState<Map<string, TermRecord[]> | null>(null);
  const [renderedCount, setRenderedCount] = useState(SECTIONS_PER_CHUNK);
  // 未描画セクションへのジャンプ先を、描画が追いつくまで持ち越す(#135)。描画自体は
  // renderedCountの更新が引き起こすため、これはstateではなく「コミット後のeffectで
  // 1回読んで消す」だけのrefでよい(stateにするとeffect内setStateのカスケードになる)。
  const pendingJumpRef = useRef<Bucket | null>(null);

  useEffect(() => {
    void termsRepo.getAll().then((terms) => setBuckets(groupIntoBuckets(terms)));
  }, [termsRepo]);

  const hasOther = (buckets?.get(OTHER_BUCKET)?.length ?? 0) > 0;
  // filterの型絞り込みで「その他」抜きの型にならないよう明示する(indexOfへBucketを渡すため)
  const visibleBuckets: readonly Bucket[] = hasOther ? BUCKET_ORDER : BUCKET_ORDER.filter((b) => b !== OTHER_BUCKET);

  // 残りのセクションをチャンクごとに追加していく(#135)。requestAnimationFrameで
  // 「1フレームにつき1チャンク」を保証する——setTimeout(0)だと描画フレームの合間に
  // 複数チャンクのコミットが溜まり、次のフレームでまとめてスタイル計算されて
  // 結局長いフレームに戻ることを実測で確認したため。
  useEffect(() => {
    if (buckets === null || renderedCount >= visibleBuckets.length) return;
    const id = requestAnimationFrame(() => setRenderedCount((c) => c + SECTIONS_PER_CHUNK));
    return () => cancelAnimationFrame(id);
  }, [buckets, renderedCount, visibleBuckets.length]);

  function scrollToSection(bucket: Bucket) {
    document.getElementById(sectionId(bucket))?.scrollIntoView({ behavior: 'auto', block: 'start' });
    // content-visibilityの仮高さで着地がずれた場合の補正(コンポーネントのコメント参照)
    requestAnimationFrame(() => {
      document.getElementById(sectionId(bucket))?.scrollIntoView({ behavior: 'auto', block: 'start' });
    });
  }

  function jumpTo(bucket: Bucket) {
    const index = visibleBuckets.indexOf(bucket);
    if (index >= renderedCount) {
      // まだ描画していないセクションへのジャンプ。そこまで一度に描画し、コミット後の
      // effect(pendingJumpRef)でスクロールする。
      setRenderedCount(index + 1);
      pendingJumpRef.current = bucket;
      return;
    }
    scrollToSection(bucket);
  }

  useEffect(() => {
    const pending = pendingJumpRef.current;
    if (pending === null) return;
    // buckets読み込み前はセクション自体がまだDOMに無い(読み込み完了後の再実行で拾う)
    if (buckets === null) return;
    if (visibleBuckets.indexOf(pending) >= renderedCount) return; // まだ描画されていない
    pendingJumpRef.current = null;
    scrollToSection(pending);
  }, [buckets, renderedCount, visibleBuckets]);

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
        visibleBuckets.slice(0, renderedCount).map((b) => (
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
