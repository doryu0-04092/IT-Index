import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { buildTermRecord } from '@it-index/shared';
import type { ChatRepository } from '../repositories/chat';
import type { TermsRepository } from '../repositories/terms';
import type { ChatMessageRecord, ChatSessionRecord } from '../types';
import SearchScreen from './SearchScreen';

function fakeTermsRepo(): TermsRepository {
  const terms = [
    buildTermRecord({ term: 'TCP/IP', readings: ['ティーシーピーアイピー'], summary: '通信規約', field: 'ネットワーク', origin: 'seed', now: 1 }),
    buildTermRecord({ term: 'アルゴリズム', readings: ['アルゴリズム'], summary: '計算手順', field: 'アルゴリズムとプログラミング', origin: 'seed', now: 1 }),
    // キーボード操作テスト用。同じ問い合わせ文字列に2件マッチさせるためだけの語で、
    // 他テストのクエリ('TCP'・'アルゴリズム'・'クオンタムコンピューティング'・'存在しない語')
    // とは文字種・字面が重ならないため0件判定に影響しない。
    buildTermRecord({ term: 'テスト用語A', readings: ['テストようごえー'], summary: null, field: '基礎理論', origin: 'seed', now: 1 }),
    buildTermRecord({ term: 'テスト用語B', readings: ['テストようごびー'], summary: null, field: '基礎理論', origin: 'seed', now: 1 }),
  ];
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

/** 「取り込み待ち」まわりの新規propsの既定値。個々のテストで上書きする */
const pendingDefaults = {
  onCommitPending: () => {},
  onDeclineSession: () => {},
  failedCommitSessionIds: new Set<string>(),
  pendingRefreshTick: 0,
};

/**
 * @param sessions セッション一覧
 * @param emptySessionIds messages.length===0にしたいセッションID(「まだ何もやり取りしていない」
 *   セッションを除外する仕様(v1 SearchScreen.tsx:93)を検証するため、既定では全セッションに
 *   1件メッセージがある前提にし、個別に空へ切り替えられるようにする)
 */
function fakeChatRepo(sessions: ChatSessionRecord[] = [], emptySessionIds: Set<string> = new Set()): ChatRepository {
  return {
    createSession: () => Promise.reject(new Error('not implemented')),
    appendMessage: () => Promise.resolve(),
    touchSession: () => Promise.resolve(),
    getOpenSessions: () => Promise.resolve(sessions.filter((s) => s.status === 'open')),
    findOpenSessionByTermId: () => Promise.resolve(undefined),
    findOpenSessionBySubjectLabel: () => Promise.resolve(undefined),
    getSession: (id) => Promise.resolve(sessions.find((s) => s.id === id)),
    beginCommit: () => Promise.resolve(false),
    abortCommit: () => Promise.resolve(),
    commitSession: () => Promise.resolve(),
    declineSession: () => Promise.resolve(),
    getMessages: (sessionId) => {
      if (emptySessionIds.has(sessionId)) return Promise.resolve([]);
      const message: ChatMessageRecord = { id: `${sessionId}-m1`, sessionId, role: 'user', content: 'hi', at: 1 };
      return Promise.resolve([message]);
    },
    getRecentSessions: () => Promise.resolve(sessions),
    deleteUnansweredOpenSessions: () => Promise.resolve(),
  };
}

describe('SearchScreen', () => {
  afterEach(cleanup);

  it('入力をデバウンスして絞り込んだ結果を表示する', async () => {
    const onSelectTerm = vi.fn();
    render(
      <SearchScreen
        termsRepo={fakeTermsRepo()}
        chatRepo={fakeChatRepo()}
        onSelectTerm={onSelectTerm}
        onAskAi={() => {}}
        onResumeChat={() => {}}
        {...pendingDefaults}
        seedError={null}
        seedRefreshTick={0}
        onRetrySeed={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText('登録単語数(4語)')).toBeTruthy());

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'アルゴリズム' } });

    await waitFor(() => expect(screen.getAllByText('アルゴリズム').length).toBeGreaterThan(0), { timeout: 1000 });
    expect(screen.queryByText('TCP/IP')).toBeNull();
  });

  it('検索結果を選ぶとonSelectTermが呼ばれる', async () => {
    const onSelectTerm = vi.fn();
    render(
      <SearchScreen
        termsRepo={fakeTermsRepo()}
        chatRepo={fakeChatRepo()}
        onSelectTerm={onSelectTerm}
        onAskAi={() => {}}
        onResumeChat={() => {}}
        {...pendingDefaults}
        seedError={null}
        seedRefreshTick={0}
        onRetrySeed={() => {}}
      />,
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
        chatRepo={fakeChatRepo()}
        onSelectTerm={() => {}}
        onAskAi={() => {}}
        onResumeChat={() => {}}
        {...pendingDefaults}
        seedError="取り込みを中止しました: 理由"
        seedRefreshTick={0}
        onRetrySeed={onRetrySeed}
      />,
    );

    fireEvent.click(screen.getByText('再試行'));
    expect(onRetrySeed).toHaveBeenCalled();
  });

  it('検索欄に1文字でも入力すると「AIで検索」ボタンが出て、押すとonAskAiが呼ばれる(v1同様、空でなければ常時表示)', () => {
    const onAskAi = vi.fn();
    render(
      <SearchScreen
        termsRepo={fakeTermsRepo()}
        chatRepo={fakeChatRepo()}
        onSelectTerm={() => {}}
        onAskAi={onAskAi}
        onResumeChat={() => {}}
        {...pendingDefaults}
        seedError={null}
        seedRefreshTick={0}
        onRetrySeed={() => {}}
      />,
    );

    // デバウンス前でも即時に出る(query.trim()を条件にしているため)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'クオンタムコンピューティング' } });
    const button = screen.getByText('「クオンタムコンピューティング」をAIで検索');
    expect(button.className).toContain('btn-primary');
    fireEvent.click(button);

    expect(onAskAi).toHaveBeenCalledWith('クオンタムコンピューティング');
  });

  it('0件時はv1と同じ文言の誘導文を表示する(専用の強調ボタンは無く、上の「AIで検索」ボタン1本に一本化)', async () => {
    const onAskAi = vi.fn();
    render(
      <SearchScreen
        termsRepo={fakeTermsRepo()}
        chatRepo={fakeChatRepo()}
        onSelectTerm={() => {}}
        onAskAi={onAskAi}
        onResumeChat={() => {}}
        {...pendingDefaults}
        seedError={null}
        seedRefreshTick={0}
        onRetrySeed={() => {}}
      />,
    );

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '存在しない語' } });
    await waitFor(
      () =>
        expect(
          screen.getByText('「存在しない語」に一致する語は辞書にありませんでした。上の「AIで検索」から質問できます。'),
        ).toBeTruthy(),
      { timeout: 1000 },
    );

    // 二本立てだった強調ボタン(search-ask-ai-primary)は廃止済み。残るのは検索欄直下の1本だけ
    expect(document.querySelector('.search-ask-ai-primary')).toBeNull();
    fireEvent.click(screen.getByText('「存在しない語」をAIで検索'));
    expect(onAskAi).toHaveBeenCalledWith('存在しない語');
  });

  it('取り込み待ち(status:open)セッションを一覧表示し、選ぶとonResumeChatが呼ばれる', async () => {
    const onResumeChat = vi.fn();
    const session: ChatSessionRecord = {
      id: 'session-1',
      termId: null,
      subjectLabel: 'ゼロトラスト',
      startedAt: 1,
      lastActiveAt: 1,
      status: 'open',
    };
    render(
      <SearchScreen
        termsRepo={fakeTermsRepo()}
        chatRepo={fakeChatRepo([session])}
        onSelectTerm={() => {}}
        onAskAi={() => {}}
        onResumeChat={onResumeChat}
        {...pendingDefaults}
        seedError={null}
        seedRefreshTick={0}
        onRetrySeed={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText('単語帳への取り込み待ち(1件)')).toBeTruthy());
    const button = screen.getByText('ゼロトラスト');
    fireEvent.click(button);

    expect(onResumeChat).toHaveBeenCalledWith('session-1');
  });

  it('検索欄に1文字でも入力すると取り込み待ち一覧は消える(v1 SearchScreen.tsx:218-222)', async () => {
    const session: ChatSessionRecord = {
      id: 'session-1',
      termId: null,
      subjectLabel: 'ゼロトラスト',
      startedAt: 1,
      lastActiveAt: 1,
      status: 'open',
    };
    render(
      <SearchScreen
        termsRepo={fakeTermsRepo()}
        chatRepo={fakeChatRepo([session])}
        onSelectTerm={() => {}}
        onAskAi={() => {}}
        onResumeChat={() => {}}
        {...pendingDefaults}
        seedError={null}
        seedRefreshTick={0}
        onRetrySeed={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText('ゼロトラスト')).toBeTruthy());

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'ア' } });

    await waitFor(() => expect(screen.queryByText('ゼロトラスト')).toBeNull(), { timeout: 1000 });
  });

  it('messages.length===0のセッション(チャットを開いてすぐ戻っただけ)は取り込み待ちに出さない', async () => {
    const untouched: ChatSessionRecord = {
      id: 'session-empty',
      termId: null,
      subjectLabel: '開いてすぐ戻った語',
      startedAt: 1,
      lastActiveAt: 1,
      status: 'open',
    };
    const touched: ChatSessionRecord = {
      id: 'session-1',
      termId: null,
      subjectLabel: 'ゼロトラスト',
      startedAt: 1,
      lastActiveAt: 1,
      status: 'open',
    };
    render(
      <SearchScreen
        termsRepo={fakeTermsRepo()}
        chatRepo={fakeChatRepo([untouched, touched], new Set(['session-empty']))}
        onSelectTerm={() => {}}
        onAskAi={() => {}}
        onResumeChat={() => {}}
        {...pendingDefaults}
        seedError={null}
        seedRefreshTick={0}
        onRetrySeed={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText('ゼロトラスト')).toBeTruthy());
    expect(screen.queryByText('開いてすぐ戻った語')).toBeNull();
  });

  it('status:declinedのセッションは取り込み待ちに出さない(取り込み履歴タブへ移した)', async () => {
    const declined: ChatSessionRecord = {
      id: 'session-declined',
      termId: null,
      subjectLabel: '登録しなかった語',
      startedAt: 1,
      lastActiveAt: 1,
      status: 'declined',
    };
    render(
      <SearchScreen
        termsRepo={fakeTermsRepo()}
        chatRepo={fakeChatRepo([declined])}
        onSelectTerm={() => {}}
        onAskAi={() => {}}
        onResumeChat={() => {}}
        {...pendingDefaults}
        seedError={null}
        seedRefreshTick={0}
        onRetrySeed={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText('登録単語数(4語)')).toBeTruthy());
    expect(screen.queryByText('登録しなかった語')).toBeNull();
  });

  it('「取り込む」を押すとonCommitPendingが呼ばれ一覧から消える', async () => {
    const onCommitPending = vi.fn();
    const session: ChatSessionRecord = {
      id: 'session-1',
      termId: null,
      subjectLabel: 'ゼロトラスト',
      startedAt: 1,
      lastActiveAt: 1,
      status: 'open',
    };
    render(
      <SearchScreen
        termsRepo={fakeTermsRepo()}
        chatRepo={fakeChatRepo([session])}
        onSelectTerm={() => {}}
        onAskAi={() => {}}
        onResumeChat={() => {}}
        {...pendingDefaults}
        onCommitPending={onCommitPending}
        seedError={null}
        seedRefreshTick={0}
        onRetrySeed={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText('ゼロトラスト')).toBeTruthy());
    fireEvent.click(screen.getByText('取り込む'));

    expect(onCommitPending).toHaveBeenCalledWith('session-1');
    await waitFor(() => expect(screen.queryByText('ゼロトラスト')).toBeNull());
  });

  it('「登録しない」を押すとonDeclineSessionが呼ばれ一覧から消える', async () => {
    const onDeclineSession = vi.fn();
    const session: ChatSessionRecord = {
      id: 'session-1',
      termId: null,
      subjectLabel: 'ゼロトラスト',
      startedAt: 1,
      lastActiveAt: 1,
      status: 'open',
    };
    render(
      <SearchScreen
        termsRepo={fakeTermsRepo()}
        chatRepo={fakeChatRepo([session])}
        onSelectTerm={() => {}}
        onAskAi={() => {}}
        onResumeChat={() => {}}
        {...pendingDefaults}
        onDeclineSession={onDeclineSession}
        seedError={null}
        seedRefreshTick={0}
        onRetrySeed={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText('ゼロトラスト')).toBeTruthy());
    fireEvent.click(screen.getByText('登録しない'));

    expect(onDeclineSession).toHaveBeenCalledWith('session-1');
    await waitFor(() => expect(screen.queryByText('ゼロトラスト')).toBeNull());
  });

  it('「まとめて単語帳に取り込む」を押すと全件についてonCommitPendingが呼ばれ一覧が空になる', async () => {
    const onCommitPending = vi.fn();
    const sessions: ChatSessionRecord[] = [
      { id: 'session-1', termId: null, subjectLabel: 'ゼロトラスト', startedAt: 1, lastActiveAt: 2, status: 'open' },
      { id: 'session-2', termId: null, subjectLabel: 'コンテナ', startedAt: 1, lastActiveAt: 1, status: 'open' },
    ];
    render(
      <SearchScreen
        termsRepo={fakeTermsRepo()}
        chatRepo={fakeChatRepo(sessions)}
        onSelectTerm={() => {}}
        onAskAi={() => {}}
        onResumeChat={() => {}}
        {...pendingDefaults}
        onCommitPending={onCommitPending}
        seedError={null}
        seedRefreshTick={0}
        onRetrySeed={() => {}}
      />,
    );

    const commitAll = await waitFor(() => screen.getByText('まとめて単語帳に取り込む(2件)'), { timeout: 1000 });
    fireEvent.click(commitAll);

    expect(onCommitPending).toHaveBeenCalledWith('session-1');
    expect(onCommitPending).toHaveBeenCalledWith('session-2');
    expect(onCommitPending).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByText('単語帳への取り込み待ち(2件)')).toBeNull());
  });

  it('failedCommitSessionIdsに含まれるセッションには失敗マークを表示する', async () => {
    const session: ChatSessionRecord = {
      id: 'session-1',
      termId: null,
      subjectLabel: 'ゼロトラスト',
      startedAt: 1,
      lastActiveAt: 1,
      status: 'open',
    };
    render(
      <SearchScreen
        termsRepo={fakeTermsRepo()}
        chatRepo={fakeChatRepo([session])}
        onSelectTerm={() => {}}
        onAskAi={() => {}}
        onResumeChat={() => {}}
        {...pendingDefaults}
        failedCommitSessionIds={new Set(['session-1'])}
        seedError={null}
        seedRefreshTick={0}
        onRetrySeed={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText('前回の取り込みに失敗しました')).toBeTruthy());
  });

  describe('キーボード操作(v1 ../../../src/ui/pc/SearchScreen.tsx:141-192,277-301を移植)', () => {
    // jsdomはscrollIntoViewを実装していない(TermIndexScreen.test.tsxと同じ対処)。
    // activeIndex変更時のuseEffectが呼ぶため、呼び出し自体はno-opスタブで許容する。
    Element.prototype.scrollIntoView = vi.fn();

    async function renderWithTwoResults(onSelectTerm = vi.fn()) {
      render(
        <SearchScreen
          termsRepo={fakeTermsRepo()}
          chatRepo={fakeChatRepo()}
          onSelectTerm={onSelectTerm}
          onAskAi={() => {}}
          onResumeChat={() => {}}
          {...pendingDefaults}
          seedError={null}
          seedRefreshTick={0}
          onRetrySeed={() => {}}
        />,
      );
      const combobox = screen.getByRole('combobox');
      fireEvent.change(combobox, { target: { value: 'テスト' } });
      await waitFor(() => expect(screen.getAllByRole('option').length).toBe(2), { timeout: 1000 });
      return { combobox, onSelectTerm };
    }

    it('↑↓キーで選択位置が移動し、aria-activedescendantが連番で更新される', async () => {
      const { combobox } = await renderWithTwoResults();
      const options = screen.getAllByRole('option');

      expect(combobox.getAttribute('aria-activedescendant')).toBeNull();

      fireEvent.keyDown(combobox, { key: 'ArrowDown' });
      expect(combobox.getAttribute('aria-activedescendant')).toBe('search-result-0');
      expect(options[0].getAttribute('aria-selected')).toBe('true');

      fireEvent.keyDown(combobox, { key: 'ArrowDown' });
      expect(combobox.getAttribute('aria-activedescendant')).toBe('search-result-1');
      expect(options[1].getAttribute('aria-selected')).toBe('true');

      // 末尾から↓で先頭へ折り返す
      fireEvent.keyDown(combobox, { key: 'ArrowDown' });
      expect(combobox.getAttribute('aria-activedescendant')).toBe('search-result-0');

      // 先頭から↑で末尾へ折り返す
      fireEvent.keyDown(combobox, { key: 'ArrowUp' });
      expect(combobox.getAttribute('aria-activedescendant')).toBe('search-result-1');
    });

    it('Enterキーで選択中の行のonSelectTermが呼ばれる', async () => {
      const onSelectTerm = vi.fn();
      const { combobox } = await renderWithTwoResults(onSelectTerm);

      fireEvent.keyDown(combobox, { key: 'ArrowDown' });
      fireEvent.keyDown(combobox, { key: 'Enter' });

      expect(onSelectTerm).toHaveBeenCalledTimes(1);
    });

    it('Escapeキーは2段階(まず選択解除、次に入力クリア)', async () => {
      const { combobox } = await renderWithTwoResults();

      fireEvent.keyDown(combobox, { key: 'ArrowDown' });
      expect(combobox.getAttribute('aria-activedescendant')).toBe('search-result-0');

      // 1段目: 選択解除。入力文字列はまだ残る
      fireEvent.keyDown(combobox, { key: 'Escape' });
      expect(combobox.getAttribute('aria-activedescendant')).toBeNull();
      expect((combobox as HTMLInputElement).value).toBe('テスト');

      // 2段目: 入力クリア
      fireEvent.keyDown(combobox, { key: 'Escape' });
      await waitFor(() => expect((combobox as HTMLInputElement).value).toBe(''));
    });

    it('入力を変更するとactiveIndexがリセットされる', async () => {
      const { combobox } = await renderWithTwoResults();

      fireEvent.keyDown(combobox, { key: 'ArrowDown' });
      expect(combobox.getAttribute('aria-activedescendant')).toBe('search-result-0');

      fireEvent.change(combobox, { target: { value: 'テスト用' } });
      expect(combobox.getAttribute('aria-activedescendant')).toBeNull();
    });
  });
});
