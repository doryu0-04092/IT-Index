import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';

const seed = {
  schemaVersion: 1,
  version: 'test-v1',
  terms: [{ term: 'HTTP', readings: ['エイチティーティーピー'], summary: '通信規約', field: 'ネットワーク' }],
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(seed) }),
  );
});

describe('App', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('見出しを表示し、シード取り込み後に登録単語数を表示する', async () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'IT-Index v2' })).toBeTruthy();
    await waitFor(() => expect(screen.getByText('登録単語数(1語)')).toBeTruthy());
  });

  it('検索→詳細→戻る、のフローが動く(v2の主機能を単一UIで一通し)', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('登録単語数(1語)')).toBeTruthy());

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'HTTP' } });
    const result = await waitFor(() => screen.getByText('HTTP'), { timeout: 1000 });
    fireEvent.click(result.closest('button')!);

    await waitFor(() => expect(screen.getByRole('heading', { name: /HTTP/ })).toBeTruthy());
    expect(screen.getByText('通信規約')).toBeTruthy();

    fireEvent.click(screen.getByText('← 戻る'));
    await waitFor(() => expect(screen.getByRole('combobox')).toBeTruthy());
  });

  it('索引タブへ切り替えられる', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('登録単語数(1語)')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: '索引' }));
    await waitFor(() => expect(screen.getByText('HTTP')).toBeTruthy());
  });

  it('履歴タブへ切り替えられ、既定は時系列(重み付けタブボタンはナビに無い)', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('登録単語数(1語)')).toBeTruthy());

    expect(screen.queryByRole('button', { name: '重み付け' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '履歴' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '時系列' })).toBeTruthy());
    expect(screen.getByRole('button', { name: '時系列' }).getAttribute('aria-current')).toBe('page');
    await waitFor(() => expect(screen.getByText('まだ記録がありません。')).toBeTruthy());
  });

  it('履歴タブの重み付けサブタブから詳細を開いて戻ると、重み付けサブタブに戻る(returnTo)', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('登録単語数(1語)')).toBeTruthy());

    // まず検索経由でHTTPの詳細を開き、asksに確定を1件記録させる(履歴に出すため)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'HTTP' } });
    const result = await waitFor(() => screen.getByText('HTTP'), { timeout: 1000 });
    fireEvent.click(result.closest('button')!);
    await waitFor(() => expect(screen.getByRole('heading', { name: /HTTP/ })).toBeTruthy());
    fireEvent.click(screen.getByText('← 戻る'));
    await waitFor(() => expect(screen.getByRole('combobox')).toBeTruthy());

    // 履歴タブ→重み付けサブタブに切り替えてHTTPを開く
    fireEvent.click(screen.getByRole('button', { name: '履歴' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '重み付け' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '重み付け' }));
    const weightedResult = await waitFor(() => screen.getByText('HTTP'), { timeout: 1000 });
    fireEvent.click(weightedResult.closest('button')!);

    await waitFor(() => expect(screen.getByRole('heading', { name: /HTTP/ })).toBeTruthy());
    fireEvent.click(screen.getByText('← 戻る'));

    // 開いていたサブタブ(重み付け)に戻っている
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '重み付け' }).getAttribute('aria-current')).toBe('page'),
    );
  });
});
