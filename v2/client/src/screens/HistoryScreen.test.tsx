import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { buildTermRecord, type AskRecord, type TermRecord } from '@it-index/shared';
import type { AsksRepository } from '../repositories/asks';
import type { ChatRepository } from '../repositories/chat';
import type { NoteConflictsRepository } from '../repositories/noteConflicts';
import type { NotesRepository } from '../repositories/notes';
import type { SyncEventsRepository } from '../repositories/syncEvents';
import type { TermsRepository } from '../repositories/terms';
import type { HistoryView } from '../navigation';
import type { ChatMessageRecord, ChatSessionRecord, NoteConflictRecord, SyncEventRecord } from '../types';
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

function fakeNotesRepo(): NotesRepository {
  return {
    getByTermId: () => Promise.resolve(undefined),
    getAll: () => Promise.resolve([]),
    saveBody: () => Promise.resolve(),
    applyCommit: () => Promise.resolve(),
    upsertFromSync: () => Promise.resolve(),
    applyConflictResolution: vi.fn(() => Promise.resolve()),
    adoptPeerDecision: () => Promise.resolve(),
  };
}

function fakeNoteConflictsRepo(conflicts: NoteConflictRecord[] = []): NoteConflictsRepository {
  return {
    add: () => Promise.reject(new Error('not implemented')),
    pruneResolved: () => Promise.resolve(0),
    getAllOrdered: () => Promise.resolve([...conflicts].sort((a, b) => b.detectedAt - a.detectedAt)),
    getOpen: () => Promise.resolve(conflicts.filter((c) => c.resolution === null && c.closedReason === null)),
    findOpenByTermAndPeer: () => Promise.resolve(undefined),
    getBySyncEventId: (id) => Promise.resolve(conflicts.filter((c) => c.syncEventId === id)),
    refresh: () => Promise.resolve(),
    carryOver: () => Promise.resolve(),
    closeAuto: () => Promise.resolve(),
    setResolution: vi.fn(() => Promise.resolve()),
  };
}

function fakeSyncEventsRepo(events: SyncEventRecord[] = []): SyncEventsRepository {
  const sorted = () => [...events].sort((a, b) => b.at - a.at);
  return {
    put: () => Promise.resolve(),
    getLatest: () => Promise.resolve(sorted()[0]),
    getRecent: (limit) => Promise.resolve(sorted().slice(0, limit)),
    updateOutcome: () => Promise.resolve(),
  };
}

function makeSyncEvent(id: string, at: number, conflictCount = 0): SyncEventRecord {
  return { id, at, pushedSeq: 1, receivedBlobs: 1, skippedBlobs: 0, conflictCount, peerDeviceIds: ['d2'], completed: true };
}

function makeConflictRecord(overrides: Partial<NoteConflictRecord> = {}): NoteConflictRecord {
  const base = { diagrams: [], resolvedAt: null, noteHistory: [] };
  return {
    id: 'conflict-1',
    termId: 'tcp-ip',
    detectedAt: 1000,
    peerDeviceId: 'd2',
    local: { ...base, termId: 'tcp-ip', body: 'この端末の内容', updatedAt: 100, lastEditedBy: 'd1' },
    remote: { ...base, termId: 'tcp-ip', body: '相手の端末の内容', updatedAt: 200, lastEditedBy: 'd2' },
    resolution: null,
    merged: null,
    resolvedAt: null,
    syncEventId: 'event-1',
    closedReason: null,
    closedAt: null,
    ...overrides,
  };
}

function renderHistory(
  asksRepo: AsksRepository,
  termsRepo: TermsRepository,
  view: HistoryView = 'timeline',
  chatRepo: ChatRepository = fakeChatRepo(),
  options: {
    conflicts?: NoteConflictRecord[];
    syncEvents?: SyncEventRecord[];
    isNativeApp?: boolean;
  } = {},
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
      notesRepo={fakeNotesRepo()}
      noteConflictsRepo={fakeNoteConflictsRepo(options.conflicts ?? [])}
      syncEventsRepo={fakeSyncEventsRepo(options.syncEvents ?? [])}
      aiClient={{ send: vi.fn() }}
      isNativeApp={options.isNativeApp ?? false}
      deviceId="d1"
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
    it('タブ順は時系列→重み付け→取り込み履歴→連携履歴→競合', async () => {
      renderHistory(fakeAsksRepo([]), fakeTermsRepo([]));
      await waitFor(() => expect(screen.getAllByRole('button').length).toBeGreaterThan(0));
      const tabs = screen.getAllByRole('button').filter((b) => b.className.includes('app-nav-link'));
      expect(tabs.map((b) => b.textContent)).toEqual(['時系列', '重み付け', '取り込み履歴', '連携履歴', '競合']);
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

  describe('連携履歴・競合タブ(#157)', () => {
    it('連携履歴タブは同期を新しい順に表示し、競合ありの行の「競合を見る」で競合タブへ移動する', async () => {
      const events = [makeSyncEvent('event-1', 1000), makeSyncEvent('event-2', 2000, 1)];
      const conflicts = [makeConflictRecord({ syncEventId: 'event-2' })];
      const { onChangeView } = renderHistory(fakeAsksRepo([]), fakeTermsRepo([]), 'sync', fakeChatRepo(), {
        syncEvents: events,
        conflicts,
      });

      await waitFor(() => expect(screen.getByText(/競合1件/)).toBeTruthy());
      const rows = screen.getAllByRole('listitem');
      // 新しい順(event-2が先頭)
      expect(within(rows[0]).getByText(/競合1件/)).toBeTruthy();
      expect(within(rows[1]).getByText(/競合0件/)).toBeTruthy();
      // 競合0件の行には「競合を見る」が無い
      expect(within(rows[1]).queryByRole('button', { name: '競合を見る' })).toBeNull();

      fireEvent.click(within(rows[0]).getByRole('button', { name: '競合を見る' }));
      expect(onChangeView).toHaveBeenCalledWith('conflicts');
    });

    it('競合タブは同期イベント単位にグループ表示し、PC側では選び直しができる', async () => {
      const events = [makeSyncEvent('event-1', 1000, 1)];
      const conflicts = [makeConflictRecord({ syncEventId: 'event-1', resolution: 'local', resolvedAt: 1500 })];
      renderHistory(fakeAsksRepo([]), fakeTermsRepo([]), 'conflicts', fakeChatRepo(), {
        syncEvents: events,
        conflicts,
      });

      await waitFor(() => expect(screen.getByText('tcp-ip')).toBeTruthy());
      // 同期イベントの見出し(日時 + 「の同期」)でグループ化されている
      expect(screen.getByText(/の同期$/)).toBeTruthy();
      // 採用中バッジと選び直しボタン(未採用側のみ)が出る
      expect(screen.getByText('✓ 採用中')).toBeTruthy();
      expect(screen.getAllByRole('button', { name: 'こちらを採用' })).toHaveLength(1);
    });

    it('Androidネイティブでは競合タブ自体を出さない(#165)', async () => {
      renderHistory(fakeAsksRepo([]), fakeTermsRepo([]), 'timeline', fakeChatRepo(), { isNativeApp: true });

      await waitFor(() => expect(screen.getAllByRole('button').length).toBeGreaterThan(0));
      const tabs = screen.getAllByRole('button').filter((b) => b.className.includes('app-nav-link'));
      expect(tabs.map((b) => b.textContent)).toEqual(['時系列', '重み付け', '取り込み履歴', '連携履歴']);
    });

    it('Androidネイティブの連携履歴は競合件数を表示するが「競合を見る」は出さない(#165)', async () => {
      const events = [makeSyncEvent('event-1', 1000, 1)];
      const conflicts = [makeConflictRecord({ syncEventId: 'event-1' })];
      renderHistory(fakeAsksRepo([]), fakeTermsRepo([]), 'sync', fakeChatRepo(), {
        syncEvents: events,
        conflicts,
        isNativeApp: true,
      });

      await waitFor(() => expect(screen.getByText(/競合1件/)).toBeTruthy());
      expect(screen.queryByRole('button', { name: '競合を見る' })).toBeNull();
    });

    /**
     * #224 で期待値を変更した。元は「自動クローズ済みは一律で選び直し不可」だったが、
     * 内容が揃って自動で閉じた競合は**利用者が一度も選んでいない**ため、それでは選び直す
     * 手段が無くなる(退避した版は競合レコードが保持しているのに使えない)。
     * 'peer-decision'(AndroidがPCの決定を採用した記録)だけは対象外のまま——
     * 解消をPC側に集約する設計(#157/#165)を崩さないため。
     */
    it('自動クローズ済みの競合は理由を表示し、peer-decision以外は選び直せる(#224)', async () => {
      const events = [makeSyncEvent('event-1', 1000, 1)];
      const conflicts = [
        makeConflictRecord({ id: 'c1', termId: 'tcp-ip', syncEventId: 'event-1', closedReason: 'peer-decision', closedAt: 2000 }),
        makeConflictRecord({ id: 'c2', termId: 'dns', syncEventId: 'event-1', closedReason: 'converged', closedAt: 2000 }),
      ];
      renderHistory(fakeAsksRepo([]), fakeTermsRepo([]), 'conflicts', fakeChatRepo(), {
        syncEvents: events,
        conflicts,
      });

      await waitFor(() => expect(screen.getByText('tcp-ip')).toBeTruthy());
      expect(screen.getByText('パソコン側の解消結果に統一済みです。')).toBeTruthy();
      expect(screen.getByText('相手の端末と同じ内容になったため決着しました。')).toBeTruthy();
      // convergedの1件ぶん(この端末/相手の2つ)だけ出る。peer-decisionの分は出ない
      expect(screen.getAllByRole('button', { name: 'こちらを採用' })).toHaveLength(2);
    });

    /** #224以前に書かれた 'superseded' の記録も、文言が出て選び直せること(移行の担保) */
    it('旧レコードの superseded も理由を表示し、選び直せる(#224)', async () => {
      const events = [makeSyncEvent('event-1', 1000, 1)];
      const conflicts = [
        makeConflictRecord({ id: 'c3', termId: 'dns', syncEventId: 'event-1', closedReason: 'superseded', closedAt: 2000 }),
      ];
      renderHistory(fakeAsksRepo([]), fakeTermsRepo([]), 'conflicts', fakeChatRepo(), {
        syncEvents: events,
        conflicts,
      });

      await waitFor(() => expect(screen.getByText('dns')).toBeTruthy());
      expect(screen.getByText('解消済みです(次の同期で競合が再発しませんでした)。')).toBeTruthy();
      expect(screen.getAllByRole('button', { name: 'こちらを採用' })).toHaveLength(2);
    });

    /**
     * 競合の見せ方を同期画面と揃える(#225)。同じ競合が画面によって別物に見えると、
     * 1つの語の経緯を追えなくなる。**同期イベントごとの区切りは残したまま**、
     * その中を単語ごとにまとめて縦一列で描く(ConflictGroupItem)。
     */
    it('競合タブは同期画面と同じ ConflictGroupItem で描かれ、イベントの区切りは残る(#225)', async () => {
      const events = [makeSyncEvent('event-1', 1000, 2)];
      const conflicts = [
        makeConflictRecord({ id: 'c1', termId: 'tcp-ip', peerDeviceId: 'device-2', syncEventId: 'event-1' }),
        makeConflictRecord({ id: 'c2', termId: 'tcp-ip', peerDeviceId: 'device-3', syncEventId: 'event-1' }),
      ];
      renderHistory(fakeAsksRepo([]), fakeTermsRepo([]), 'conflicts', fakeChatRepo(), {
        syncEvents: events,
        conflicts,
      });

      // 同期画面と同じ testid(単語ごとのグループ・端末ごとの行)で出る
      await waitFor(() => expect(screen.getByTestId('conflict-group-tcp-ip')).toBeTruthy());
      expect(screen.getByTestId('conflict-device-device-2')).toBeTruthy();
      expect(screen.getByTestId('conflict-device-device-3')).toBeTruthy();
      // 同じ語の2台ぶんが1枚にまとまる(以前は競合ごとに別カードだった)
      expect(screen.getAllByTestId(/^conflict-group-/)).toHaveLength(1);
      // イベントの区切りは残す(時系列の軸を失わないため)
      expect(screen.getByText(/の同期$/)).toBeTruthy();
    });

    it('競合0件時は「まだ競合の記録がありません。」を表示する', async () => {
      renderHistory(fakeAsksRepo([]), fakeTermsRepo([]), 'conflicts');
      await waitFor(() => expect(screen.getByText('まだ競合の記録がありません。')).toBeTruthy());
    });
  });
});
