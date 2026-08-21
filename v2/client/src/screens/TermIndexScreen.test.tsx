import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { buildTermRecord, type TermRecord } from '@it-index/shared';
import type { TermsRepository } from '../repositories/terms';
import TermIndexScreen from './TermIndexScreen';

function fakeTermsRepo(terms: TermRecord[]): TermsRepository {
  return {
    getAll: () => Promise.resolve(terms),
    getAllForSync: () => Promise.resolve(terms),
    getById: (id) => Promise.resolve(terms.find((t) => t.id === id)),
    bulkPutFromSeed: () => Promise.resolve(),
    softDelete: () => Promise.resolve(),
    upsertFromSync: () => Promise.resolve(),
    upsertFromAi: () => Promise.resolve(),
  };
}

const BASE_TERMS = [
  buildTermRecord({ term: 'TCP/IP', readings: ['ティーシーピーアイピー'], summary: '通信規約', field: 'ネットワーク', origin: 'seed', now: 1 }),
  buildTermRecord({ term: 'アルゴリズム', readings: ['アルゴリズム'], summary: '計算手順', field: 'アルゴリズムとプログラミング', origin: 'seed', now: 1 }),
];

// readingsが無く記号始まりのため、どのバケットにも分類できず「その他」行きになる語(kanaRow.ts bucketOf参照)。
const OTHER_TERM = buildTermRecord({ term: '★特殊記号', readings: [], summary: null, field: '基礎理論', origin: 'seed', now: 1 });

/**
 * 段階描画(#135)の待ち時間を、実行環境の速さに依存させないための差し替え(#186)。
 *
 * `TermIndexScreen` は索引の73セクションを `requestAnimationFrame` で6件ずつ描画する。
 * 最後のセクションまで到達するには**12フレーム**必要で、jsdomのrAFは約16ms刻み。
 * 全テスト(63ファイル)を並列実行すると1フレームあたりの実時間が伸び、
 * 末尾を待つテストが `waitFor` の既定(1000ms)に間に合わず不定期に落ちていた
 * (他のテストはナビゲーションしか見ておらず、最初の1フレームで揃うため落ちない)。
 *
 * rAFをマクロタスク(`setTimeout(cb, 0)`)へ差し替えると、1フレームあたりの下限16msが消える。
 * **同期実行にはしない**——effect内から同期的にコールバックを呼ぶと、
 * 状態更新→再レンダー→effect→…が入れ子で再帰して積み上がるため。
 *
 * **実測(単体実行・このマシン): 差し替えなし411ms → 差し替えあり217ms。**
 * 半分になるが**ゼロにはならない**——残りは73セクションを描画する実コストで、
 * タイマー由来ではないため差し替えでは消せない。そのため待ち上限を広げる対処も併せて要る
 * (各テストのコメント参照)。当初「差し替えだけで数msになる」と見積もったが、
 * 実測して誤りと分かったので両方入れている。
 *
 * 差し替えは描画の速さだけを変え、段階描画のロジック(1フレーム1チャンク)は変えない。
 */
function useImmediateAnimationFrames() {
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;

  beforeEach(() => {
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 0) as unknown as number) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((id: number) =>
      clearTimeout(id as unknown as NodeJS.Timeout)) as typeof cancelAnimationFrame;
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancel;
  });
}

describe('TermIndexScreen', () => {
  useImmediateAnimationFrames();
  afterEach(cleanup);

  it('頭文字・五十音・数字-その他の3つのジャンプ領域が別々に存在する', async () => {
    render(<TermIndexScreen termsRepo={fakeTermsRepo(BASE_TERMS)} onSelectTerm={() => {}} />);

    await waitFor(() => expect(screen.getByRole('navigation', { name: '頭文字へジャンプ' })).toBeTruthy());
    expect(screen.getByRole('navigation', { name: '五十音へジャンプ' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: '数字・その他へジャンプ' })).toBeTruthy();
  });

  it('「頭文字へジャンプ」内はA〜Zの26個で、ア行や「数字」を含まない', async () => {
    render(<TermIndexScreen termsRepo={fakeTermsRepo(BASE_TERMS)} onSelectTerm={() => {}} />);

    const nav = await waitFor(() => screen.getByRole('navigation', { name: '頭文字へジャンプ' }));
    const buttons = nav.querySelectorAll('button');
    expect(buttons.length).toBe(26);
    const labels = Array.from(buttons).map((b) => b.textContent);
    expect(labels).not.toContain('ア');
    expect(labels).not.toContain('数字');
  });

  it('五十音図はボタン45個・空マスがaria-hiddenのspan5個(10列×5行、ヤ行・ワ行の欠けは null)', async () => {
    render(<TermIndexScreen termsRepo={fakeTermsRepo(BASE_TERMS)} onSelectTerm={() => {}} />);

    const grid = await waitFor(() => screen.getByRole('navigation', { name: '五十音へジャンプ' }));
    expect(grid.querySelectorAll('button').length).toBe(45);
    expect(grid.querySelectorAll('span[aria-hidden="true"]').length).toBe(5);
  });

  it('「その他」に該当する語が0件ならリンクも見出しも出ない', async () => {
    render(<TermIndexScreen termsRepo={fakeTermsRepo(BASE_TERMS)} onSelectTerm={() => {}} />);

    await waitFor(() => expect(screen.getByRole('navigation', { name: '頭文字へジャンプ' })).toBeTruthy());
    expect(screen.queryByText('その他')).toBeNull();
  });

  it('「その他」に該当する語があればリンク・見出しの両方が出る', async () => {
    render(<TermIndexScreen termsRepo={fakeTermsRepo([...BASE_TERMS, OTHER_TERM])} onSelectTerm={() => {}} />);

    // 「その他」セクションは並び順の最後のため、段階描画(#135)が末尾まで到達するのを待つ。
    //
    // 待ち上限を既定(1000ms)から広げる(#186)。**遅さを隠すためではなく、この待ちが
    // 実際の描画量に見合っていないため**——実測すると単体実行でも末尾到達に約220ms掛かり
    // (73セクションを12チャンクに分けて描画する実コスト。rAFの差し替え前は約410ms)、
    // 全63ファイルの並列実行ではここが数倍に伸びて1000msを超えていた。
    //
    // 1000msという既定値は「即座に現れるものを待つ」ための値で、ここでの正しさとは無関係。
    // このテストが確かめているのは「最終的にリンクと見出しの2つが出る」ことであり、
    // それが何ms掛かるかは主張していない。上限は**実コストに見合う予算**として与える。
    await waitFor(() => expect(screen.getAllByText('その他').length).toBe(2), { timeout: 5000 }); // リンク＋見出し
    expect(screen.getByText('★特殊記号')).toBeTruthy();
  });

  it('「一番上へ戻る」ボタンを押すとwindow.scrollToが{top:0}で呼ばれる', async () => {
    if (!window.scrollTo) {
      window.scrollTo = () => {};
    }
    const scrollToSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    render(<TermIndexScreen termsRepo={fakeTermsRepo(BASE_TERMS)} onSelectTerm={() => {}} />);

    await waitFor(() => expect(screen.getByRole('navigation', { name: '頭文字へジャンプ' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '一番上へ戻る' }));

    expect(scrollToSpy).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
    scrollToSpy.mockRestore();
  });

  it('索引の<ul>はresult-listクラスを持たずterm-index-listクラスを持つ', async () => {
    const { container } = render(<TermIndexScreen termsRepo={fakeTermsRepo(BASE_TERMS)} onSelectTerm={() => {}} />);

    await waitFor(() => expect(container.querySelectorAll('ul').length).toBeGreaterThan(0));
    const lists = container.querySelectorAll('ul');
    expect(lists.length).toBeGreaterThan(0);
    for (const ul of Array.from(lists)) {
      expect(ul.classList.contains('result-list')).toBe(false);
      expect(ul.classList.contains('term-index-list')).toBe(true);
    }
  });

  it('ジャンプボタンを押すと対象セクションのscrollIntoViewが呼ばれる', async () => {
    const scrollIntoViewSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoViewSpy;
    render(<TermIndexScreen termsRepo={fakeTermsRepo(BASE_TERMS)} onSelectTerm={() => {}} />);

    // 段階描画(#135)のため、先頭セクションが描画されてからジャンプする
    await waitFor(() => expect(document.getElementById('term-index-section-A')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'A' }));

    await waitFor(() =>
      expect(scrollIntoViewSpy).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto', block: 'start' })),
    );
  });

  it('段階描画(#135): セクションはチャンクで追加され、最終的に全バケット分そろう', async () => {
    const { container } = render(<TermIndexScreen termsRepo={fakeTermsRepo(BASE_TERMS)} onSelectTerm={() => {}} />);

    // 「その他」該当なしのため全72バケット(英字26+五十音45+数字)のセクションが出そろう
    // 末尾セクションまでの描画を待つため、上記と同じ理由で上限を広げる(#186)
    await waitFor(() => expect(container.querySelectorAll('.term-index-section').length).toBe(72), {
      timeout: 5000,
    });
    expect(screen.getByText('TCP/IP')).toBeTruthy();
    // 「アルゴリズム」は語名と読みの両方に現れるためgetAllByTextで確認する
    expect(screen.getAllByText('アルゴリズム').length).toBeGreaterThan(0);
  });

  it('段階描画(#135): 未描画のセクションへのジャンプは、描画されてからscrollIntoViewされる', async () => {
    const scrollIntoViewSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoViewSpy;
    render(<TermIndexScreen termsRepo={fakeTermsRepo(BASE_TERMS)} onSelectTerm={() => {}} />);

    await waitFor(() => expect(screen.getByRole('navigation', { name: '数字・その他へジャンプ' })).toBeTruthy());
    // 「数字」は並び順の最後(index 71)で、読み込み直後はまず未描画のままジャンプされる
    fireEvent.click(screen.getByRole('button', { name: '数字' }));

    // 末尾(index 71)まで描画が進んでからスクロールされるため、同じ理由で上限を広げる(#186)
    await waitFor(() => expect(scrollIntoViewSpy).toHaveBeenCalled(), { timeout: 5000 });
    // スクロールが実行された時点で対象セクション自体もDOMに存在している
    expect(document.getElementById(`term-index-section-${encodeURIComponent('数字')}`)).toBeTruthy();
  });
});
