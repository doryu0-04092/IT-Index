import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { buildTermRecord } from '@it-index/shared';
import type { ChatRepository } from '../repositories/chat';
import type { TermsRepository } from '../repositories/terms';
import type { ChatSessionRecord } from '../types';
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

function fakeChatRepo(sessions: ChatSessionRecord[] = []): ChatRepository {
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
    getMessages: () => Promise.resolve([]),
    getRecentSessions: () => Promise.resolve(sessions),
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

    await waitFor(() => expect(screen.getByText('登録単語数(2語)')).toBeTruthy());

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

  it('検索欄に入力すると「AIで検索」ボタンが出て、押すとonAskAiが呼ばれる', async () => {
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

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'クオンタムコンピューティング' } });
    const button = await waitFor(() => screen.getByText('「クオンタムコンピューティング」についてAIで検索'), { timeout: 1000 });
    fireEvent.click(button);

    expect(onAskAi).toHaveBeenCalledWith('クオンタムコンピューティング');
  });

  it('取り込み待ちセッションを一覧表示し、選ぶとonResumeChatが呼ばれる', async () => {
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

    const button = await waitFor(() => screen.getByText('ゼロトラスト'), { timeout: 1000 });
    fireEvent.click(button);

    expect(onResumeChat).toHaveBeenCalledWith('session-1');
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
    await waitFor(() => expect(screen.queryByText('取り込み待ち')).toBeNull());
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
});
