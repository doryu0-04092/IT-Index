import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { buildTermRecord, type AskRecord, type TermRecord } from '@it-index/shared';
import type { AsksRepository } from '../repositories/asks';
import type { ChatRepository } from '../repositories/chat';
import type { TermsRepository } from '../repositories/terms';
import type { ChatMessageRecord, ChatSessionRecord } from '../types';
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

/**
 * @param sessions セッション一覧
 * @param emptySessionIds messages.length===0にしたいセッションID(既定では全セッションに
 *   1件メッセージがある前提にする。SearchScreen.test.tsxのfakeChatRepoと同じ方針)
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
    getRecentSessions: () => Promise.resolve([...sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt)),
    deleteUnansweredOpenSessions: () => Promise.resolve(),
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

function renderHistory(
  asksRepo: AsksRepository,
  termsRepo: TermsRepository,
  view: 'timeline' | 'weighted' | 'commits' = 'timeline',
  chatRepo: ChatRepository = fakeChatRepo(),
) {
  const onChangeView = vi.fn();
  const onSelectTerm = vi.fn();
  const onOpenChatSession = vi.fn();
  const onCommitPending = vi.fn();
  const utils = render(
    <HistoryScreen
      asksRepo={asksRepo}
      termsRepo={termsRepo}
      chatRepo={chatRepo}
      view={view}
      onChangeView={onChangeView}
      onSelectTerm={onSelectTerm}
      onOpenChatSession={onOpenChatSession}
      onCommitPending={onCommitPending}
    />,
  );
  return { ...utils, onChangeView, onSelectTerm, onOpenChatSession, onCommitPending };
}

describe('HistoryScreen', () => {
  afterEach(cleanup);

  it('既定(view=timeline)で時系列サブタブがaria-current=pageになる', async () => {
    renderHistory(fakeAsksRepo([ask(HTTP.id, 1)]), fakeTermsRepo([HTTP]));

    await waitFor(() => expect(screen.getByRole('button', { name: '時系列' })).toBeTruthy());
    expect(screen.getByRole('button', { name: '時系列' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: '重み付け' }).getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('button', { name: '取り込み履歴' }).getAttribute('aria-current')).toBeNull();
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

  describe('取り込み履歴タブ(本人指定「検索機能周りに関してはV1を踏襲」。全ステータスを時系列表示)', () => {
    it('タブ順は時系列→重み付け→取り込み履歴', async () => {
      renderHistory(fakeAsksRepo([]), fakeTermsRepo([]));
      await waitFor(() => expect(screen.getAllByRole('button').length).toBeGreaterThan(0));
      const tabs = screen.getAllByRole('button').filter((b) => b.className.includes('app-nav-link'));
      expect(tabs.map((b) => b.textContent)).toEqual(['時系列', '重み付け', '取り込み履歴']);
    });

    it('セッションを一覧表示し(ラベル+状態バッジ+日時)、行タップでonOpenChatSessionが呼ばれる', async () => {
      const at = new Date('2026-02-03T04:05:06').getTime();
      const declined: ChatSessionRecord = {
        id: 'session-declined',
        termId: null,
        subjectLabel: '登録しなかった語',
        startedAt: 1,
        lastActiveAt: at,
        status: 'declined',
      };
      const { onOpenChatSession } = renderHistory(fakeAsksRepo([]), fakeTermsRepo([]), 'commits', fakeChatRepo([declined]));

      await waitFor(() => expect(screen.getByText('登録しなかった語')).toBeTruthy());
      expect(screen.getByText('登録しない')).toBeTruthy();
      expect(screen.getByText(new Date(at).toLocaleString('ja-JP'))).toBeTruthy();

      fireEvent.click(screen.getByText('登録しなかった語'));
      expect(onOpenChatSession).toHaveBeenCalledWith('session-declined');
    });

    it('「取り込む」を押すとonCommitPendingが呼ばれ一覧から消える', async () => {
      const declined: ChatSessionRecord = {
        id: 'session-declined',
        termId: null,
        subjectLabel: '登録しなかった語',
        startedAt: 1,
        lastActiveAt: 1,
        status: 'declined',
      };
      const { onCommitPending } = renderHistory(
        fakeAsksRepo([]),
        fakeTermsRepo([]),
        'commits',
        fakeChatRepo([declined]),
      );

      await waitFor(() => expect(screen.getByText('登録しなかった語')).toBeTruthy());
      fireEvent.click(screen.getByText('取り込む'));

      expect(onCommitPending).toHaveBeenCalledWith('session-declined');
      await waitFor(() => expect(screen.queryByText('登録しなかった語')).toBeNull());
    });

    it('open/declined/committed/committingの全セッションをlastActiveAt降順で表示する', async () => {
      const sessions: ChatSessionRecord[] = [
        { id: 'session-open', termId: null, subjectLabel: '取り込み待ちの語', startedAt: 1, lastActiveAt: 1000, status: 'open' },
        {
          id: 'session-committed',
          termId: null,
          subjectLabel: '取り込み済みの語',
          startedAt: 1,
          lastActiveAt: 4000,
          status: 'committed',
        },
        {
          id: 'session-declined',
          termId: null,
          subjectLabel: '登録しなかった語',
          startedAt: 1,
          lastActiveAt: 3000,
          status: 'declined',
        },
        {
          id: 'session-committing',
          termId: null,
          subjectLabel: '取り込み中の語',
          startedAt: 1,
          lastActiveAt: 2000,
          status: 'committing',
        },
      ];
      renderHistory(fakeAsksRepo([]), fakeTermsRepo([]), 'commits', fakeChatRepo(sessions));

      await waitFor(() => expect(screen.getByText('取り込み済みの語')).toBeTruthy());
      const buttons = screen.getAllByRole('button').filter((b) => b.className.includes('search-pending-item'));
      expect(buttons.map((b) => b.textContent)).toEqual([
        expect.stringContaining('取り込み済みの語'),
        expect.stringContaining('登録しなかった語'),
        expect.stringContaining('取り込み中の語'),
        expect.stringContaining('取り込み待ちの語'),
      ]);
      expect(screen.getByText('取り込み待ち')).toBeTruthy();
      expect(screen.getByText('登録しない')).toBeTruthy();
      expect(screen.getByText('取り込み済み')).toBeTruthy();
      expect(screen.getByText('取り込み中…')).toBeTruthy();
    });

    it('「取り込む」ボタンはopen/declinedの行にだけ出て、committed/committingには出ない', async () => {
      const sessions: ChatSessionRecord[] = [
        { id: 'session-open', termId: null, subjectLabel: '取り込み待ちの語', startedAt: 1, lastActiveAt: 1, status: 'open' },
        {
          id: 'session-declined',
          termId: null,
          subjectLabel: '登録しなかった語',
          startedAt: 1,
          lastActiveAt: 2,
          status: 'declined',
        },
        {
          id: 'session-committed',
          termId: null,
          subjectLabel: '取り込み済みの語',
          startedAt: 1,
          lastActiveAt: 3,
          status: 'committed',
        },
        {
          id: 'session-committing',
          termId: null,
          subjectLabel: '取り込み中の語',
          startedAt: 1,
          lastActiveAt: 4,
          status: 'committing',
        },
      ];
      renderHistory(fakeAsksRepo([]), fakeTermsRepo([]), 'commits', fakeChatRepo(sessions));

      await waitFor(() => expect(screen.getByText('取り込み中の語')).toBeTruthy());
      expect(screen.getAllByText('取り込む').length).toBe(2);

      const committedRow = screen.getByText('取り込み済みの語').closest('li');
      const committingRow = screen.getByText('取り込み中の語').closest('li');
      expect(committedRow && within(committedRow).queryByText('取り込む')).toBeNull();
      expect(committingRow && within(committingRow).queryByText('取り込む')).toBeNull();
    });

    it('messages.length===0のセッションは一覧に出さない', async () => {
      const declined: ChatSessionRecord = {
        id: 'session-declined-empty',
        termId: null,
        subjectLabel: '開いてすぐ戻った語',
        startedAt: 1,
        lastActiveAt: 1,
        status: 'declined',
      };
      renderHistory(
        fakeAsksRepo([]),
        fakeTermsRepo([]),
        'commits',
        fakeChatRepo([declined], new Set(['session-declined-empty'])),
      );

      await waitFor(() => expect(screen.getByText('まだ記録がありません。')).toBeTruthy());
    });

    it('0件時は「まだ記録がありません。」を表示する', async () => {
      renderHistory(fakeAsksRepo([]), fakeTermsRepo([]), 'commits');
      await waitFor(() => expect(screen.getByText('まだ記録がありません。')).toBeTruthy());
    });
  });
});
