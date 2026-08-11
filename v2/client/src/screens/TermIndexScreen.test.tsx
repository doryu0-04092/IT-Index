import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('TermIndexScreen', () => {
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

    await waitFor(() => expect(screen.getAllByText('その他').length).toBeGreaterThan(0));
    expect(screen.getAllByText('その他').length).toBe(2); // リンク＋見出し
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

    await waitFor(() => expect(screen.getByRole('navigation', { name: '頭文字へジャンプ' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'A' }));

    expect(scrollIntoViewSpy).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto', block: 'start' }));
  });
});
