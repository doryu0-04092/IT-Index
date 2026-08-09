import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { buildTermRecord } from '@it-index/shared';
import type { TermsRepository } from '../repositories/terms';
import SearchScreen from './SearchScreen';

function fakeTermsRepo(): TermsRepository {
  const terms = [
    buildTermRecord({ term: 'TCP/IP', readings: ['ティーシーピーアイピー'], summary: '通信規約', field: 'ネットワーク', origin: 'seed', now: 1 }),
    buildTermRecord({ term: 'アルゴリズム', readings: ['アルゴリズム'], summary: '計算手順', field: 'アルゴリズムとプログラミング', origin: 'seed', now: 1 }),
  ];
  return {
    getAll: () => Promise.resolve(terms),
    getAllForSync: () => Promise.resolve(terms),
    getById: (id) => Promise.resolve(terms.find((t) => t.id === id)),
    bulkPutFromSeed: () => Promise.resolve(),
    softDelete: () => Promise.resolve(),
    upsertFromSync: () => Promise.resolve(),
  };
}

describe('SearchScreen', () => {
  afterEach(cleanup);

  it('入力をデバウンスして絞り込んだ結果を表示する', async () => {
    const onSelectTerm = vi.fn();
    render(
      <SearchScreen termsRepo={fakeTermsRepo()} onSelectTerm={onSelectTerm} seedError={null} seedRefreshTick={0} onRetrySeed={() => {}} />,
    );

    await waitFor(() => expect(screen.getByText('登録単語数(2語)')).toBeTruthy());

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'アルゴリズム' } });

    await waitFor(() => expect(screen.getAllByText('アルゴリズム').length).toBeGreaterThan(0), { timeout: 1000 });
    expect(screen.queryByText('TCP/IP')).toBeNull();
  });

  it('検索結果を選ぶとonSelectTermが呼ばれる', async () => {
    const onSelectTerm = vi.fn();
    render(
      <SearchScreen termsRepo={fakeTermsRepo()} onSelectTerm={onSelectTerm} seedError={null} seedRefreshTick={0} onRetrySeed={() => {}} />,
    );

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'TCP' } });
    const result = await waitFor(() => screen.getByText('TCP/IP'), { timeout: 1000 });
    fireEvent.click(result.closest('button')!);

    expect(onSelectTerm).toHaveBeenCalledWith('tcp/ip');
  });

  it('シード取り込みエラーがあれば再試行ボタンを表示する', () => {
    const onRetrySeed = vi.fn();
    render(
      <SearchScreen
        termsRepo={fakeTermsRepo()}
        onSelectTerm={() => {}}
        seedError="取り込みを中止しました: 理由"
        seedRefreshTick={0}
        onRetrySeed={onRetrySeed}
      />,
    );

    fireEvent.click(screen.getByText('再試行'));
    expect(onRetrySeed).toHaveBeenCalled();
  });
});
