import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from './App';
import { db } from './db';
import { createChatRepository } from './repositories/chat';
import { clearPersistedScreen, persistScreen } from './screenPersistence';
import { setToken } from './sync/tokenStore';

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
    // オンボーディング既読・テーマ選択の永続化(localStorage)がテスト間で持ち越されないようにする
    // (onboarding.ts/theme.ts追加により、この2キーが新たにlocalStorageを使うようになったため)。
    localStorage.clear();
  });

  it('見出しを表示し、シード取り込み後に登録単語数を表示する', async () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'IT-Index' })).toBeTruthy();
    await waitFor(() => expect(screen.getByText('登録単語数(1語)')).toBeTruthy());
  });

  it('検索→詳細→戻る、のフローが動く(v2の主機能を単一UIで一通し)', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('登録単語数(1語)')).toBeTruthy());

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'HTTP' } });
    const result = await waitFor(() => screen.getByText('HTTP'));
    fireEvent.click(result.closest('button')!);

    await waitFor(() => expect(screen.getByRole('heading', { name: /HTTP/ })).toBeTruthy());
    expect(screen.getByText('通信規約')).toBeTruthy();

    fireEvent.click(screen.getByText('← 戻る'));
    await waitFor(() => expect(screen.getByRole('combobox')).toBeTruthy());
  });

  it('5つのタブ(検索/索引/履歴/設定/同期)が表示され、設定タブに切り替えられる', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('登録単語数(1語)')).toBeTruthy());

    const nav = screen.getByRole('navigation', { name: '画面切り替え' });
    for (const label of ['検索', '索引', '履歴', '設定', '同期']) {
      expect(within(nav).getByRole('button', { name: label })).toBeTruthy();
    }

    fireEvent.click(within(nav).getByRole('button', { name: '設定' }));
    await waitFor(() => expect(screen.getByText('ライセンス')).toBeTruthy());
    expect(screen.getByRole('button', { name: '設定' }).getAttribute('aria-current')).toBe('page');
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
    const result = await waitFor(() => screen.getByText('HTTP'));
    fireEvent.click(result.closest('button')!);
    await waitFor(() => expect(screen.getByRole('heading', { name: /HTTP/ })).toBeTruthy());
    fireEvent.click(screen.getByText('← 戻る'));
    await waitFor(() => expect(screen.getByRole('combobox')).toBeTruthy());

    // 履歴タブ→重み付けサブタブに切り替えてHTTPを開く
    fireEvent.click(screen.getByRole('button', { name: '履歴' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '重み付け' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '重み付け' }));
    const weightedResult = await waitFor(() => screen.getByText('HTTP'));
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

  it('初回起動時はオンボーディングを表示し、「次回から表示しない」で閉じると既読後は出ない', async () => {
    const { unmount } = render(<App />);
    await waitFor(() => expect(screen.getByText('登録単語数(1語)')).toBeTruthy());
    expect(screen.getByText('IT-Indexへようこそ')).toBeTruthy();

    // 「次回から表示しない」はデフォルトでチェック済み。最終ステップまで進めて閉じる
    fireEvent.click(screen.getByText('次へ')); // ① 検索する
    fireEvent.click(screen.getByText('次へ')); // ② AIに聞く
    fireEvent.click(screen.getByText('次へ')); // ③ 同期でデータを揃える
    fireEvent.click(screen.getByText('始める'));
    expect(screen.queryByText('IT-Indexへようこそ')).toBeNull();

    unmount();
    render(<App />);
    await waitFor(() => expect(screen.getByText('登録単語数(1語)')).toBeTruthy());
    expect(screen.queryByText('IT-Indexへようこそ')).toBeNull();
  });

  it('未ログイン時に「取り込み待ち」一覧の取り込むを押すと同期画面へ誘導される', async () => {
    const chatRepo = createChatRepository(db);
    const session = await chatRepo.createSession(null, 'ゼロトラスト');
    await chatRepo.appendMessage(session.id, 'user', 'ゼロトラストとは？');
    // assistant返答が無いと起動時クリーンアップ(#132)で削除され、一覧に出る前に消えてしまう
    await chatRepo.appendMessage(session.id, 'assistant', '境界を信用しない考え方です。');

    render(<App />);
    await waitFor(() => expect(screen.getByText('登録単語数(1語)')).toBeTruthy());

    await waitFor(() => expect(screen.getByText('ゼロトラスト')).toBeTruthy());
    fireEvent.click(screen.getByText('取り込む'));

    await waitFor(() => expect(screen.getByRole('button', { name: '同期' }).getAttribute('aria-current')).toBe('page'));

    // 後始末: このセッションが他テストの「取り込み待ち」一覧に混入しないようにする
    await chatRepo.declineSession(session.id);
  });

  describe('遅延生成(本人指定): セッションは最初の送信が成立するまで作られない', () => {
    it('未ログインで「AIで検索」→戻ると、セッションが作られない', async () => {
      render(<App />);
      await waitFor(() => expect(screen.getByText('登録単語数(1語)')).toBeTruthy());

      fireEvent.change(screen.getByRole('combobox'), { target: { value: '遅延生成テストA' } });
      fireEvent.click(screen.getByText('「遅延生成テストA」をAIで検索'));

      await waitFor(() => expect(screen.getByText('AIチャットにはログインが必要です。')).toBeTruthy());
      fireEvent.click(screen.getByText('← 戻る'));
      await waitFor(() => expect(screen.getByRole('combobox')).toBeTruthy());

      const chatRepo = createChatRepository(db);
      const open = await chatRepo.getOpenSessions();
      expect(open.find((s) => s.subjectLabel === '遅延生成テストA')).toBeUndefined();
    });

    it('ログイン済みで送信が成立するとセッションが作成される', async () => {
      setToken('tok-delay-1');
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string) => {
          const u = String(url);
          if (u.includes('/ai/chat')) {
            return Promise.resolve({
              ok: true,
              json: () =>
                Promise.resolve({ text: '応答テストA', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }),
            });
          }
          if (u.includes('/ai/quota')) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ used: 0, limit: 50 }) });
          }
          return Promise.resolve({ ok: true, json: () => Promise.resolve(seed) });
        }),
      );

      render(<App />);
      await waitFor(() => expect(screen.getByText('登録単語数(1語)')).toBeTruthy());

      fireEvent.change(screen.getByRole('combobox'), { target: { value: '遅延生成テストB' } });
      fireEvent.click(screen.getByText('「遅延生成テストB」をAIで検索'));

      await waitFor(() => expect(screen.getByText('応答テストA')).toBeTruthy());

      const chatRepo = createChatRepository(db);
      const open = await chatRepo.getOpenSessions();
      const created = open.find((s) => s.subjectLabel === '遅延生成テストB');
      expect(created).toBeTruthy();
      expect(await chatRepo.getMessages(created!.id)).toHaveLength(2);

      fireEvent.click(screen.getByText('← 戻る'));
      await waitFor(() => expect(screen.getByText(/単語帳への取り込み待ち/)).toBeTruthy());
      expect(screen.getByText('遅延生成テストB')).toBeTruthy();

      await chatRepo.declineSession(created!.id);
    });

    it('送信に失敗した場合はセッションが作られず、取り込み待ちにも出ない(#132)', async () => {
      setToken('tok-delay-2');
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string) => {
          const u = String(url);
          if (u.includes('/ai/chat')) {
            return Promise.resolve({
              ok: false,
              status: 500,
              json: () => Promise.resolve({ error: { code: 'unknown_error', message: 'サーバーエラー' } }),
            });
          }
          if (u.includes('/ai/quota')) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ used: 0, limit: 50 }) });
          }
          return Promise.resolve({ ok: true, json: () => Promise.resolve(seed) });
        }),
      );

      render(<App />);
      await waitFor(() => expect(screen.getByText('登録単語数(1語)')).toBeTruthy());

      fireEvent.change(screen.getByRole('combobox'), { target: { value: '遅延生成テストC' } });
      fireEvent.click(screen.getByText('「遅延生成テストC」をAIで検索'));

      await waitFor(() => expect(screen.getByText('サーバーエラー')).toBeTruthy());

      // AI応答が受信できなかったため、登録用の情報(セッション・メッセージ)は一切残らない
      const chatRepo = createChatRepository(db);
      const open = await chatRepo.getOpenSessions();
      expect(open.find((s) => s.subjectLabel === '遅延生成テストC')).toBeUndefined();

      // 検索画面に戻っても「取り込み待ち」には出ない
      fireEvent.click(screen.getByText('← 戻る'));
      await waitFor(() => expect(screen.getByRole('combobox')).toBeTruthy());
      expect(screen.queryByText('遅延生成テストC')).toBeNull();
    });

    it('既存openセッションがあれば再利用し、新規セッションは作られない(従来どおり)', async () => {
      const chatRepo = createChatRepository(db);
      const existing = await chatRepo.createSession(null, '遅延生成テストD');
      await chatRepo.appendMessage(existing.id, 'user', '既存の質問');
      // assistant返答が無いと起動時クリーンアップ(#132)で削除され、再利用対象が消えてしまう
      await chatRepo.appendMessage(existing.id, 'assistant', '既存の返答');

      setToken('tok-delay-3');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(seed) }));

      render(<App />);
      await waitFor(() => expect(screen.getByText('登録単語数(1語)')).toBeTruthy());

      fireEvent.change(screen.getByRole('combobox'), { target: { value: '遅延生成テストD' } });
      fireEvent.click(screen.getByText('「遅延生成テストD」をAIで検索'));

      await waitFor(() => expect(screen.getByText('既存の質問')).toBeTruthy());
      // 再開(既存セッション)なので初期質問の自動送信はしない=AIプロキシは呼ばれない
      expect(globalThis.fetch).not.toHaveBeenCalledWith(expect.stringContaining('/ai/chat'), expect.anything());

      const open = await chatRepo.getOpenSessions();
      expect(open.filter((s) => s.subjectLabel === '遅延生成テストD')).toHaveLength(1);

      fireEvent.click(screen.getByText('← 戻る'));
      await chatRepo.declineSession(existing.id);
    });

    it('起動時クリーンアップはAI返答が無いopenセッションを削除する(返答ありは残す。#132)', async () => {
      const chatRepo = createChatRepository(db);
      const empty = await chatRepo.createSession(null, '遅延生成テストE-空');
      const unanswered = await chatRepo.createSession(null, '遅延生成テストE-質問のみ');
      await chatRepo.appendMessage(unanswered.id, 'user', 'なにか');
      const answered = await chatRepo.createSession(null, '遅延生成テストE-返答あり');
      await chatRepo.appendMessage(answered.id, 'user', 'なにか');
      await chatRepo.appendMessage(answered.id, 'assistant', 'こたえ');

      render(<App />);
      await waitFor(() => expect(screen.getByText('登録単語数(1語)')).toBeTruthy());

      await waitFor(async () => {
        expect(await chatRepo.getSession(empty.id)).toBeUndefined();
      });
      // 旧保存順の残骸(質問のみ)も削除され、AI返答のある会話だけが残る
      expect(await chatRepo.getSession(unanswered.id)).toBeUndefined();
      expect(await chatRepo.getSession(answered.id)).toBeDefined();

      await chatRepo.declineSession(answered.id);
    });

    it('下書き(sessionId:null)チャットはリロードしても復元されず検索画面に落ちる', async () => {
      persistScreen({
        name: 'chat',
        sessionId: null,
        termId: null,
        subjectLabel: '遅延生成テストF',
        returnTo: { name: 'search' },
      });

      render(<App />);

      await waitFor(() => expect(screen.getByText('登録単語数(1語)')).toBeTruthy());
      expect(screen.getByRole('combobox')).toBeTruthy();
    });
  });
});
