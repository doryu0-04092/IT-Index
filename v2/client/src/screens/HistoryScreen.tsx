import { useCallback, useEffect, useMemo, useState } from 'react';
import { computeWeights, type AskRecord, type TermRecord } from '@it-index/shared';
import type { AiClient } from '../ai/aiClient';
import { loadSessionLabelRows, type SessionLabelRow } from '../lib/chatSessionLabels';
import SessionListRow from '../lib/SessionListRow';
import type { HistoryView } from '../navigation';
import type { AsksRepository } from '../repositories/asks';
import type { ChatRepository } from '../repositories/chat';
import type { NoteConflictsRepository } from '../repositories/noteConflicts';
import type { NotesRepository } from '../repositories/notes';
import type { SyncEventsRepository } from '../repositories/syncEvents';
import type { TermsRepository } from '../repositories/terms';
import { useConflictResolution } from '../sync/useConflictResolution';
import type { ChatSessionRecord, NoteConflictRecord, SyncEventRecord } from '../types';
import ConflictItem from './ConflictItem';

/** 「取り込み履歴」タブの状態バッジ(v1 ../../../src/ui/pc/HistoryScreen.tsx:40-51を移植) */
function chatStatusLabel(status: ChatSessionRecord['status']): string {
  switch (status) {
    case 'open':
      return '取り込み待ち';
    case 'declined':
      return '登録しない';
    case 'committed':
      return '取り込み済み';
    case 'committing':
      return '取り込み中…';
  }
}

/** 連携履歴に出す同期イベントの上限。チャット履歴の30件(下のgetRecentSessions)と揃える */
const SYNC_EVENTS_LIMIT = 30;

export interface HistoryScreenProps {
  asksRepo: AsksRepository;
  termsRepo: TermsRepository;
  chatRepo: ChatRepository;
  notesRepo: NotesRepository;
  noteConflictsRepo: NoteConflictsRepository;
  syncEventsRepo: SyncEventsRepository;
  /** 競合タブの「AIで統合する」に使う(SyncScreenと同じ経路) */
  aiClient: AiClient;
  /** Androidネイティブならtrue(#157)。競合タブは表示のみになる */
  isNativeApp: boolean;
  /** 競合の選び直しに使う(useAppInit参照。発行前はnull=操作不可) */
  deviceId: string | null;
  view: HistoryView;
  onChangeView: (view: HistoryView) => void;
  onSelectTerm: (termId: string) => void;
  /** 「取り込み履歴」タブの行タップで、単語詳細ではなく取り込み前後のチャットを開く */
  onOpenChatSession: (sessionId: string) => void;
  /** 「取り込み履歴」タブの「取り込む」。SearchScreenの個別「取り込む」と同じ処理を再利用する */
  onCommitPending: (sessionId: string) => void;
  /** license_required時の設定タブ誘導(SyncScreenと同じ流儀) */
  onGoToSettings?: () => void;
  /**
   * 取り込み(確定)完了の通知(#167)。この画面を開いたまま裏で取り込みが完了した場合に、
   * 時系列・取り込み履歴(状態バッジ)等を追従させる再読込トリガー(行の差し替えのみ)。
   */
  commitRefreshTick?: number;
}

const TABS: readonly { view: HistoryView; label: string }[] = [
  { view: 'timeline', label: '時系列' },
  { view: 'weighted', label: '重み付け' },
  { view: 'commits', label: '取り込み履歴' },
  { view: 'sync', label: '連携履歴' },
  { view: 'conflicts', label: '競合' },
];

/**
 * 「履歴」タブ。重み付けは個人的に作った特殊な機能の1つに過ぎず、履歴としては
 * 時系列順が最低限の機能であるため(本人指定)、時系列を既定サブタブ・重み付けを
 * 2番目のサブタブとする。
 *
 * 「取り込み履歴」タブ(本人指定「検索機能周りに関してはV1を踏襲」)は、AIチャットの記録
 * (v1 ../../../src/ui/pc/HistoryScreen.tsx:64-69・270-294のcommitsタブを移植)。
 *
 * 「連携履歴」「競合」タブは#157で追加(v1の連携履歴・競合選択タブに相当)。
 * v1と違い両者は参照関係を持つ: 競合はsyncEventIdで同期イベントにリンクし、
 * 競合タブでは同期イベント単位にグループ表示する。連携履歴の「競合を見る」から
 * 該当グループへ移動できる。PC側では競合タブから選び直しができる(SyncScreenと同じ
 * useConflictResolutionを共有)。
 *
 * Androidネイティブ(#165)では「競合」タブ自体を出さない(連携履歴のみ)。競合の決着は
 * すべてPC側で付ける方針のため、操作できない一覧をAndroidに置かない(本人指定)。
 * 連携履歴の行の「競合n件」の件数表示は記録の痕跡として残すが、「競合を見る」は
 * 行き先が無いため出さない。
 *
 * データ取得(asks・term引き当て)はサブタブ間で共通・1回だけ行う(旧WeightedScreen.tsxの
 * ロードを移植)。並べ替え・表示だけをサブタブごとに分ける。tombstone(削除済み)の語は
 * termsRepo.getAll()が非削除のみ返すため自然に除外される。
 */
export default function HistoryScreen({
  asksRepo,
  termsRepo,
  chatRepo,
  notesRepo,
  noteConflictsRepo,
  syncEventsRepo,
  aiClient,
  isNativeApp,
  deviceId,
  view,
  onChangeView,
  onSelectTerm,
  onOpenChatSession,
  onCommitPending,
  onGoToSettings,
  commitRefreshTick = 0,
}: HistoryScreenProps) {
  const [asks, setAsks] = useState<AskRecord[]>([]);
  const [termsById, setTermsById] = useState<Map<string, TermRecord>>(new Map());
  const [commitRows, setCommitRows] = useState<SessionLabelRow[] | null>(null);
  const [syncEvents, setSyncEvents] = useState<SyncEventRecord[]>([]);
  const [conflicts, setConflicts] = useState<NoteConflictRecord[]>([]);
  // 連携履歴の「競合を見る」で移動した先のグループを強調する(画面内の一時状態。永続化しない)
  const [highlightedEventId, setHighlightedEventId] = useState<string | null>(null);

  const loadSyncData = useCallback(async () => {
    setSyncEvents(await syncEventsRepo.getRecent(SYNC_EVENTS_LIMIT));
    setConflicts(await noteConflictsRepo.getAllOrdered());
  }, [syncEventsRepo, noteConflictsRepo]);

  const { mergingId, mergeErrors, mergeErrorCodes, chooseLocal, chooseRemote, merge } = useConflictResolution({
    deviceId,
    notesRepo,
    noteConflictsRepo,
    aiClient,
    onAfterResolve: loadSyncData,
  });

  useEffect(() => {
    void (async () => {
      setAsks(await asksRepo.getAllOrdered());
      const terms = await termsRepo.getAll();
      setTermsById(new Map(terms.map((t) => [t.id, t])));

      // 「取り込み履歴」タブ用。open/declined/committed/committingの全ステータスを対象にする
      // (上のコメント参照)。getRecentSessionsが既にlastActiveAt降順で返す。
      const sessions = await chatRepo.getRecentSessions(30);
      setCommitRows(await loadSessionLabelRows(chatRepo, termsRepo, sessions));

      await loadSyncData();
    })();
    // commitRefreshTick: 開いたまま取り込みが完了した場合の追従(#167。行の差し替えのみ)
  }, [asksRepo, termsRepo, chatRepo, loadSyncData, commitRefreshTick]);

  // 取り込みはバックグラウンドで進む(App.tsx側)。押した時点でこの一覧からは消してよい
  // (SearchScreen.tsxのhandleCommitPendingと同じ理由)。
  function handleCommitPending(sessionId: string) {
    onCommitPending(sessionId);
    setCommitRows((prev) => prev?.filter((r) => r.session.id !== sessionId) ?? prev);
  }

  const weightedRows = useMemo(
    () =>
      computeWeights(asks)
        .map((w) => ({ term: termsById.get(w.termId), weight: w.weight }))
        .filter((r): r is { term: TermRecord; weight: number } => r.term !== undefined),
    [asks, termsById],
  );

  // 同じ語を複数回聞いた場合、時系列ビューには最新の1件だけを表示する
  // (履歴の各行が独立した出来事ではなく「その語を最後にいつ聞いたか」を示す一覧のため。
  // v1 ../../../it-index/src/ui/pc/HistoryScreen.tsx の時系列ビューを移植)。
  const timelineRows = useMemo(() => {
    const latestByTerm = new Map<string, AskRecord>();
    for (const ask of asks) {
      const existing = latestByTerm.get(ask.termId);
      if (!existing || ask.at > existing.at) {
        latestByTerm.set(ask.termId, ask);
      }
    }
    return [...latestByTerm.values()]
      .map((ask) => ({ ask, term: termsById.get(ask.termId) }))
      .filter((r): r is { ask: AskRecord; term: TermRecord } => r.term !== undefined)
      .sort((a, b) => b.ask.at - a.ask.at);
  }, [asks, termsById]);

  // 競合タブ: 同期イベント単位のグループ(新しい順)。syncEventId:nullの旧レコード
  // (Dexie version 3以前)は「同期記録なし」グループに寄せる
  const conflictGroups = useMemo(() => {
    const eventsById = new Map(syncEvents.map((e) => [e.id, e]));
    const groups = new Map<string | null, NoteConflictRecord[]>();
    for (const c of conflicts) {
      const key = c.syncEventId !== null && eventsById.has(c.syncEventId) ? c.syncEventId : null;
      const list = groups.get(key) ?? [];
      list.push(c);
      groups.set(key, list);
    }
    return [...groups.entries()]
      .map(([eventId, list]) => ({
        eventId,
        event: eventId !== null ? eventsById.get(eventId) : undefined,
        list: list.sort((a, b) => b.detectedAt - a.detectedAt),
      }))
      .sort((a, b) => (b.event?.at ?? b.list[0].detectedAt) - (a.event?.at ?? a.list[0].detectedAt));
  }, [conflicts, syncEvents]);

  const conflictCountByEvent = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of conflicts) {
      if (c.syncEventId !== null) counts.set(c.syncEventId, (counts.get(c.syncEventId) ?? 0) + 1);
    }
    return counts;
  }, [conflicts]);

  function jumpToConflicts(eventId: string) {
    setHighlightedEventId(eventId);
    onChangeView('conflicts');
  }

  return (
    <div className="history-screen">
      <nav className="app-nav" aria-label="履歴の切り替え">
        {/* Androidネイティブでは競合タブを出さない(#165。ファイル冒頭コメント参照) */}
        {TABS.filter((tab) => !(isNativeApp && tab.view === 'conflicts')).map((tab) => (
          <button
            key={tab.view}
            type="button"
            className={view === tab.view ? 'app-nav-link app-nav-link-active' : 'app-nav-link'}
            onClick={() => onChangeView(tab.view)}
            aria-current={view === tab.view ? 'page' : undefined}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {view === 'timeline' ? (
        <>
          {timelineRows.length === 0 && <p className="status-text">まだ記録がありません。</p>}
          <ul className="result-list">
            {timelineRows.map(({ ask, term }) => (
              <li key={ask.id} className="result-row">
                <button type="button" className="result-button" onClick={() => onSelectTerm(term.id)}>
                  <span className="result-term">{term.term}</span>
                  <span className="result-field">{new Date(ask.at).toLocaleString('ja-JP')}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : view === 'weighted' ? (
        <>
          <p className="status-text">最近も繰り返し聞いている語ほど上位(=まだ定着していない語)</p>
          {weightedRows.length === 0 && <p className="status-text">まだ記録がありません。</p>}
          <ul className="result-list">
            {weightedRows.map(({ term, weight }) => (
              <li key={term.id} className="result-row">
                <button type="button" className="result-button" onClick={() => onSelectTerm(term.id)}>
                  <span className="result-term">{term.term}</span>
                  <span className="result-reading">{term.readings[0]}</span>
                  <span className="result-score">{weight.toFixed(2)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : view === 'commits' ? (
        <>
          {commitRows !== null && commitRows.length === 0 && <p className="status-text">まだ記録がありません。</p>}
          <ul className="result-list">
            {commitRows?.map((row) => (
              <SessionListRow
                key={row.session.id}
                row={row}
                onSelect={() => onOpenChatSession(row.session.id)}
                meta={<span className="result-field">{chatStatusLabel(row.session.status)}</span>}
              >
                {(row.session.status === 'open' || row.session.status === 'declined') && (
                  <button
                    type="button"
                    className="btn-secondary search-pending-commit"
                    onClick={() => handleCommitPending(row.session.id)}
                  >
                    取り込む
                  </button>
                )}
              </SessionListRow>
            ))}
          </ul>
        </>
      ) : view === 'sync' ? (
        <>
          {syncEvents.length === 0 && <p className="status-text">まだ同期の記録がありません。</p>}
          <ul className="result-list">
            {syncEvents.map((event) => {
              const conflictCount = conflictCountByEvent.get(event.id) ?? 0;
              return (
                <li key={event.id} className="result-row sync-event-row">
                  <div className="sync-event-summary">
                    <span className="result-term">{new Date(event.at).toLocaleString('ja-JP')}</span>
                    <span className="result-field">
                      {event.completed
                        ? `受信${event.receivedBlobs}件(スキップ${event.skippedBlobs}件)・競合${conflictCount}件`
                        : '途中で失敗しました'}
                    </span>
                  </div>
                  {/* Androidでは競合タブが無いため行き先も無い(#165)。件数表示だけ残す */}
                  {!isNativeApp && conflictCount > 0 && (
                    <button type="button" className="btn-secondary" onClick={() => jumpToConflicts(event.id)}>
                      競合を見る
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <>
          {isNativeApp && conflicts.length > 0 && (
            <p className="status-text">競合の解消(選び直し)はパソコン側で行ってください。</p>
          )}
          {conflicts.length === 0 && <p className="status-text">まだ競合の記録がありません。</p>}
          {conflictGroups.map((group) => (
            <div
              key={group.eventId ?? 'no-event'}
              className={`conflict-event-group${group.eventId === highlightedEventId ? ' conflict-event-group-highlight' : ''}`}
            >
              <h3 className="conflict-event-heading">
                {group.event ? `${new Date(group.event.at).toLocaleString('ja-JP')} の同期` : '(同期記録なし)'}
              </h3>
              <ul className="sync-conflict-list">
                {group.list.map((c) => (
                  <ConflictItem
                    key={c.id}
                    conflict={c}
                    canResolve={!isNativeApp}
                    merging={mergingId === c.id}
                    mergeError={mergeErrors[c.id] ?? null}
                    mergeErrorCode={mergeErrorCodes[c.id] ?? null}
                    onChooseLocal={() => chooseLocal(c)}
                    onChooseRemote={() => chooseRemote(c)}
                    onMerge={() => void merge(c)}
                    onGoToSettings={onGoToSettings}
                  />
                ))}
              </ul>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
