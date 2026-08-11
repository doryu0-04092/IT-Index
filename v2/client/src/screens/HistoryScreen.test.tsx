import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { buildTermRecord, type AskRecord, type TermRecord } from '@it-index/shared';
import type { AsksRepository } from '../repositories/asks';
import type { TermsRepository } from '../repositories/terms';
import HistoryScreen from './HistoryScreen';

function fakeAsksRepo(asks: AskRecord[]): AsksRepository {
  return {
    addSearchConfirm: () => Promise.resolve(),
    getAllOrdered: () => Promise.resolve(asks),
    getByTermId: (termId) => Promise.resolve(asks.filter((a) => a.termId === termId)),
    upsertFromSync: () => Promise.resolve(),
    addMany: () => Promise.resolve(),
  };
}

function fakeTermsRepo(terms: TermRecord[]): TermsRepository {
  return {
    getAll: () => Promise.resolve(terms.filter((t) => t.deletedAt === null)),
    getAllForSync: () => Promise.resolve(terms),
    getById: (id) => Promise.resolve(terms.find((t) => t.id === id)),
    bulkPutFromSeed: () => Promise.resolve(),
    softDelete: () => Promise.resolve(),
    upsertFromSync: () => Promise.resolve(),
    upsertFromAi: () => Promise.resolve(),
  };
}

const HTTP = buildTermRecord({
  term: 'HTTP',
  readings: ['エイチティーティーピー'],
  summary: '通信規約',
  field: 'ネットワーク',
  origin: 'seed',
  now: 1,
});
const TCP = buildTermRecord({
  term: 'TCP',
  readings: ['ティーシーピー'],
  summary: '通信規約',
  field: 'ネットワーク',
  origin: 'seed',
  now: 1,
});
const DELETED = {
  ...buildTermRecord({
    term: '削除済み語',
    readings: ['さくじょずみご'],
    summary: null,
    field: '基礎理論',
    origin: 'seed',
    now: 1,
  }),
  deletedAt: 999,
};

function ask(termId: string, at: number): AskRecord {
  return { id: `${termId}-${at}`, termId, sessionId: null, at, deviceId: 'd1', source: 'search' };
}

function renderHistory(asksRepo: AsksRepository, termsRepo: TermsRepository, view: 'timeline' | 'weighted' = 'timeline') {
  const onChangeView = vi.fn();
  const onSelectTerm = vi.fn();
  const utils = render(
    <HistoryScreen
      asksRepo={asksRepo}
      termsRepo={termsRepo}
      view={view}
      onChangeView={onChangeView}
      onSelectTerm={onSelectTerm}
    />,
  );
  return { ...utils, onChangeView, onSelectTerm };
}

describe('HistoryScreen', () => {
  afterEach(cleanup);

  it('既定(view=timeline)で時系列サブタブがaria-current=pageになる', async () => {
    renderHistory(fakeAsksRepo([ask(HTTP.id, 1)]), fakeTermsRepo([HTTP]));

    await waitFor(() => expect(screen.getByRole('button', { name: '時系列' })).toBeTruthy());
    expect(screen.getByRole('button', { name: '時系列' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: '重み付け' }).getAttribute('aria-current')).toBeNull();
  });

  it('同じ語を2回聞いた場合、時系列は最新1件のみ表示する', async () => {
    renderHistory(fakeAsksRepo([ask(HTTP.id, 1000), ask(HTTP.id, 2000)]), fakeTermsRepo([HTTP]));

    await waitFor(() => expect(screen.getAllByText('HTTP').length).toBe(1));
  });

  it('時系列はat降順で並ぶ(2語で確認)', async () => {
    renderHistory(fakeAsksRepo([ask(HTTP.id, 1000), ask(TCP.id, 2000)]), fakeTermsRepo([HTTP, TCP]));

    await waitFor(() => expect(screen.getAllByRole('button').length).toBeGreaterThan(2));
    const buttons = screen.getAllByRole('button').filter((b) => b.className.includes('result-button'));
    expect(buttons.map((b) => b.textContent)).toEqual([
      expect.stringContaining('TCP'),
      expect.stringContaining('HTTP'),
    ]);
  });

  it('時系列の行にtoLocaleString(ja-JP)形式の日時が表示される', async () => {
    const at = new Date('2026-01-02T03:04:05').getTime();
    renderHistory(fakeAsksRepo([ask(HTTP.id, at)]), fakeTermsRepo([HTTP]));

    const expected = new Date(at).toLocaleString('ja-JP');
    await waitFor(() => expect(screen.getByText(expected)).toBeTruthy());
  });

  it('重み付けタブに切り替えるとスコアと案内文が表示される', async () => {
    const { onChangeView } = renderHistory(fakeAsksRepo([ask(HTTP.id, 1)]), fakeTermsRepo([HTTP]));

    await waitFor(() => expect(screen.getByRole('button', { name: '重み付け' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '重み付け' }));
    expect(onChangeView).toHaveBeenCalledWith('weighted');

    cleanup();
    renderHistory(fakeAsksRepo([ask(HTTP.id, 1)]), fakeTermsRepo([HTTP]), 'weighted');
    await waitFor(() => expect(screen.getByText('最近も繰り返し聞いている語ほど上位(=まだ定着していない語)')).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/\d\.\d\d/)).toBeTruthy());
  });

  it('記録が0件なら両ビューで「まだ記録がありません。」を表示する', async () => {
    renderHistory(fakeAsksRepo([]), fakeTermsRepo([]), 'timeline');
    await waitFor(() => expect(screen.getByText('まだ記録がありません。')).toBeTruthy());

    cleanup();
    renderHistory(fakeAsksRepo([]), fakeTermsRepo([]), 'weighted');
    await waitFor(() => expect(screen.getByText('まだ記録がありません。')).toBeTruthy());
  });

  it('tombstone(削除済み)の語はどちらのビューにも出ない', async () => {
    renderHistory(fakeAsksRepo([ask(DELETED.id, 1), ask(HTTP.id, 2)]), fakeTermsRepo([DELETED, HTTP]));

    await waitFor(() => expect(screen.getByText('HTTP')).toBeTruthy());
    expect(screen.queryByText('削除済み語')).toBeNull();
  });
});
