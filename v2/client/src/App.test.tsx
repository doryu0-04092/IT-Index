import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import { db } from './db';
import { createChatRepository } from './repositories/chat';
import { clearPersistedScreen, persistScreen } from './screenPersistence';

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
    clearPersistedScreen();
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

  it('ブラウザの「戻る」を押すとアプリごと離脱せず検索画面へ戻る(v1 #35)', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('登録単語数(1語)')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: '索引' }));
    await waitFor(() => expect(screen.getByText('HTTP')).toBeTruthy());

    // 実ブラウザの「戻る」操作はpopstateイベントとして届く
    window.dispatchEvent(new PopStateEvent('popstate'));

    await waitFor(() => expect(screen.getByRole('combobox')).toBeTruthy());
  });

  it('リロード時に直前の画面(検索以外)を復元する(v1 #39)', async () => {
    persistScreen({ name: 'index' });

    render(<App />);

    // 復元はseedSettled後に一度だけ試みるため、索引画面の内容が出るまで待つ
    await waitFor(() => expect(screen.getByText('HTTP')).toBeTruthy());
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('保存内容が壊れている場合は検索画面のまま(復元を諦める)', async () => {
    sessionStorage.setItem('it-index-v2:last-screen', '{not json');

    render(<App />);

    await waitFor(() => expect(screen.getByText('登録単語数(1語)')).toBeTruthy());
    expect(screen.getByRole('combobox')).toBeTruthy();
  });

  it('未ログイン時に「取り込み待ち」一覧の取り込むを押すと同期画面へ誘導される', async () => {
    const chatRepo = createChatRepository(db);
    const session = await chatRepo.createSession(null, 'ゼロトラスト');
    await chatRepo.appendMessage(session.id, 'user', 'ゼロトラストとは？');

    render(<App />);
    await waitFor(() => expect(screen.getByText('登録単語数(1語)')).toBeTruthy());

    await waitFor(() => expect(screen.getByText('ゼロトラスト')).toBeTruthy());
    fireEvent.click(screen.getByText('取り込む'));

    await waitFor(() => expect(screen.getByRole('button', { name: '同期' }).getAttribute('aria-current')).toBe('page'));

    // 後始末: このセッションが他テストの「取り込み待ち」一覧に混入しないようにする
    await chatRepo.declineSession(session.id);
  });
});
