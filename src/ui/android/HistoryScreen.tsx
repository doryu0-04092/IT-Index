import { useEffect, useMemo, useState } from 'react';
import type { AiClient } from '../../ai/aiClient';
import { computeWeights } from '../../core/computeWeights';
import type { AsksRepository } from '../../repositories/asks';
import type { ChatRepository } from '../../repositories/chat';
import type { NoteConflictsRepository } from '../../repositories/noteConflicts';
import type { NotesRepository } from '../../repositories/notes';
import type { SyncEventsRepository } from '../../repositories/syncEvents';
import type { TermsRepository } from '../../repositories/terms';
import type { AskRecord, ChatSessionRecord, NoteConflictRecord, SyncEventRecord, TermRecord } from '../../types';
import { ConflictItem, CONFLICT_PC_ONLY_NOTICE } from '../shared/ConflictResolver';

export type HistoryView = 'weighted' | 'timeline' | 'sync' | 'commits' | 'conflicts';

interface ChatHistoryRow {
  session: ChatSessionRecord;
  /** 語ひも付きなら見出し語、「AIで検索」なら入力した文字列 */
  label: string;
}

export interface HistoryScreenProps {
  asksRepo: AsksRepository;
  termsRepo: TermsRepository;
  notesRepo: NotesRepository;
  syncEventsRepo: SyncEventsRepository;
  chatRepo: ChatRepository;
  conflictsRepo: NoteConflictsRepository;
  /** 競合の「AIで統合する」に使う。ConflictItemへそのまま渡す */
  claude: AiClient;
  deviceId: string;
  initialView: HistoryView;
  onSelectTerm: (termId: string) => void;
  /** 「取り込み履歴」タブの語を選ぶと、単語詳細ではなく取り込み前後のチャットを開く */
  onOpenChatSession: (sessionId: string) => void;
  /** 「取り込み履歴」タブの「取り込む」。SearchScreenの個別「取り込む」と同じ処理を再利用する */
  onCommitPending: (sessionId: string) => void;
  onBack: () => void;
}

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

function conflictStatusLabel(conflict: NoteConflictRecord): string {
  if (conflict.resolution === null) return '未解決';
  if (conflict.resolution === 'merged') return 'AIで統合';
  return conflict.resolution === 'local' ? 'この端末の内容' : '相手の端末の内容';
}

/**
 * 履歴画面（Android版）。タブ構成・データ取得・並べ替えのロジックはPC版
 * （`src/ui/pc/HistoryScreen.tsx`）と共通で、狭幅でのタブ折り返しは
 * `.android-app .history-tabs` 側のCSS（src/index.css 末尾）で対応する。
 *
 * **PC版との唯一の違いは「競合選択」タブ。** Android版では競合の選択をさせず、2案と現在の
 * 選択を表示するだけにして案内文言（`CONFLICT_PC_ONLY_NOTICE`）を出す
 * （`ConflictItem` に `canResolve={false}` を渡す）。単語詳細はパソコン版を基準に整える
 * ——両端末でそれぞれ選べると同じ語について端末ごとに違う結論が残り、次の連携でまた競合に
 * なるため、決着をつける場所をPC版1つに寄せている（2026-08-07。要件定義書§5.5）。
 * PC側で確定した内容は次の連携で自動的にこの端末へ入る（理由は ConflictResolver.tsx 参照）。
 */
export default function HistoryScreen({
  asksRepo,
  termsRepo,
  notesRepo,
  syncEventsRepo,
  chatRepo,
  conflictsRepo,
  claude,
  deviceId,
  initialView,
  onSelectTerm,
  onOpenChatSession,
  onCommitPending,
  onBack,
}: HistoryScreenProps) {
  const [view, setView] = useState<HistoryView>(initialView);
  const [asks, setAsks] = useState<AskRecord[]>([]);
  const [termsById, setTermsById] = useState<Map<string, TermRecord>>(new Map());
  const [syncEvents, setSyncEvents] = useState<SyncEventRecord[]>([]);
  const [chatRows, setChatRows] = useState<ChatHistoryRow[] | null>(null);
  const [conflictRows, setConflictRows] = useState<NoteConflictRecord[] | null>(null);
  const [expandedConflictId, setExpandedConflictId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const allAsks = await asksRepo.getAllOrdered();
      setAsks(allAsks);

      const events = await syncEventsRepo.getAllOrdered();
      setSyncEvents(events);

      setConflictRows(await conflictsRepo.getAllOrdered());

      const sessions = await chatRepo.getRecentSessions(30);
      const uniqueTermIds = new Set(allAsks.map((a) => a.termId));
      for (const e of events) {
        e.receivedTermIds.forEach((id) => uniqueTermIds.add(id));
        e.sentTermIds.forEach((id) => uniqueTermIds.add(id));
      }
      for (const session of sessions) {
        if (session.termId) uniqueTermIds.add(session.termId);
      }

      const terms = await Promise.all([...uniqueTermIds].map((id) => termsRepo.getById(id)));
      const map = new Map<string, TermRecord>();
      for (const t of terms) if (t) map.set(t.id, t);
      setTermsById(map);

      const rows: ChatHistoryRow[] = [];
      for (const session of sessions) {
        const messages = await chatRepo.getMessages(session.id);
        if (messages.length === 0) continue; // 何もやり取りしていないセッションは表示不要
        if (session.termId) {
          const term = map.get(session.termId);
          if (term) rows.push({ session, label: term.term });
        } else if (session.subjectLabel) {
          rows.push({ session, label: session.subjectLabel });
        }
      }
      setChatRows(rows);
    })();
  }, [asksRepo, termsRepo, syncEventsRepo, chatRepo, conflictsRepo]);

  const weightedRows = useMemo(
    () =>
      computeWeights(asks)
        .map((w) => ({ term: termsById.get(w.termId), weight: w.weight }))
        .filter((r): r is { term: TermRecord; weight: number } => r.term !== undefined),
    [asks, termsById],
  );

  // 同じ語を複数回聞いた場合、時系列ビューには最新の1件だけを表示する
  // （履歴の各行が独立した出来事ではなく「その語を最後にいつ聞いたか」を示す一覧のため）。
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

  const syncRows = useMemo(
    () =>
      syncEvents.map((e) => ({
        event: e,
        received: e.receivedTermIds.map((id) => termsById.get(id)).filter((t): t is TermRecord => t !== undefined),
        sent: e.sentTermIds.map((id) => termsById.get(id)).filter((t): t is TermRecord => t !== undefined),
      })),
    [syncEvents, termsById],
  );

  function handleConflictResolved(updated: NoteConflictRecord) {
    setConflictRows((prev) => prev?.map((c) => (c.id === updated.id ? updated : c)) ?? prev);
  }

  return (
    <div className="history-screen">
      <button type="button" className="term-detail-back" onClick={onBack}>
        ← 検索に戻る
      </button>

      <nav className="history-tabs">
        <button type="button" className={view === 'weighted' ? 'active' : ''} onClick={() => setView('weighted')}>
          重み付けビュー
        </button>
        <button type="button" className={view === 'timeline' ? 'active' : ''} onClick={() => setView('timeline')}>
          時系列ビュー
        </button>
        <button type="button" className={view === 'sync' ? 'active' : ''} onClick={() => setView('sync')}>
          連携履歴
        </button>
        <button type="button" className={view === 'commits' ? 'active' : ''} onClick={() => setView('commits')}>
          取り込み履歴
        </button>
        <button type="button" className={view === 'conflicts' ? 'active' : ''} onClick={() => setView('conflicts')}>
          競合選択
        </button>
      </nav>

      {view === 'weighted' ? (
        <>
          <p className="search-status">最近も繰り返し聞いている語ほど上位（＝まだ定着していない語）</p>
          {weightedRows.length === 0 && <p className="search-status">まだ記録がありません。</p>}
          <ul className="search-results">
            {weightedRows.map(({ term, weight }, index) => (
              <li key={term.id} className="stagger-row" style={{ '--stagger-index': Math.min(index, 12) } as React.CSSProperties}>
                <button type="button" className="search-result" onClick={() => onSelectTerm(term.id)}>
                  <span className="search-result-term">{term.term}</span>
                  <span className="search-result-reading">{term.readings[0]}</span>
                  <span className="search-result-score">{weight.toFixed(2)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : view === 'timeline' ? (
        <>
          {timelineRows.length === 0 && <p className="search-status">まだ記録がありません。</p>}
          <ul className="search-results">
            {timelineRows.map(({ ask, term }, index) => (
              <li key={ask.id} className="stagger-row" style={{ '--stagger-index': Math.min(index, 12) } as React.CSSProperties}>
                <button type="button" className="search-result" onClick={() => onSelectTerm(term.id)}>
                  <span className="search-result-term">{term.term}</span>
                  <span className="search-result-field">{new Date(ask.at).toLocaleString('ja-JP')}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : view === 'sync' ? (
        <>
          {syncRows.length === 0 && <p className="search-status">まだ記録がありません。</p>}
          <ul className="sync-history-list">
            {syncRows.map(({ event, received, sent }) => (
              <li key={event.id} className="sync-history-event">
                <p className="search-status">{new Date(event.at).toLocaleString('ja-JP')}</p>
                {received.length > 0 && (
                  <>
                    <p className="sync-history-label">この連携で受け取った</p>
                    <ul className="search-results">
                      {received.map((term) => (
                        <li key={term.id} className="search-result-row">
                          <button type="button" className="search-result" onClick={() => onSelectTerm(term.id)}>
                            <span className="search-result-term">{term.term}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {sent.length > 0 && (
                  <>
                    <p className="sync-history-label">この連携で渡した</p>
                    <ul className="search-results">
                      {sent.map((term) => (
                        <li key={term.id} className="search-result-row">
                          <button type="button" className="search-result" onClick={() => onSelectTerm(term.id)}>
                            <span className="search-result-term">{term.term}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : view === 'commits' ? (
        <>
          <p className="search-status">
            AIチャットの記録です。最大30件まで残ります（超えた分は古いものから削除されますが、既に単語帳へ取り込んだ内容は消えません）。
          </p>
          {chatRows !== null && chatRows.length === 0 && <p className="search-status">まだ記録がありません。</p>}
          <ul className="search-results">
            {chatRows?.map(({ session, label }) => (
              <li key={session.id} className="search-result-row">
                <button type="button" className="search-result" onClick={() => onOpenChatSession(session.id)}>
                  <span className="search-result-term">{label}</span>
                  <span className="search-result-field">{chatStatusLabel(session.status)}</span>
                </button>
                {(session.status === 'open' || session.status === 'declined') && (
                  <button
                    type="button"
                    className="search-pending-commit btn-secondary"
                    onClick={() => onCommitPending(session.id)}
                  >
                    取り込む
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <p className="search-status">
            連携（QR）で、両方の端末がそれぞれ独自に編集していた語の記録です。
          </p>
          <p className="search-status">{CONFLICT_PC_ONLY_NOTICE}</p>
          {conflictRows !== null && conflictRows.length === 0 && <p className="search-status">まだ記録がありません。</p>}
          <ul className="conflict-history-list">
            {conflictRows?.map((conflict) => (
              <li key={conflict.id} className="conflict-history-row">
                <button
                  type="button"
                  className="search-result"
                  onClick={() => setExpandedConflictId((prev) => (prev === conflict.id ? null : conflict.id))}
                >
                  <span className="search-result-term">{conflict.termId}</span>
                  <span className="search-result-field">{conflictStatusLabel(conflict)}</span>
                </button>
                {expandedConflictId === conflict.id && (
                  <div className="link-conflict">
                    {/* 選択はPC版のみ。ここは2案と現在の選択を見せるだけ（上のコメント参照） */}
                    <ConflictItem
                      conflict={conflict}
                      deps={{ notesRepo, conflictsRepo, deviceId, claude }}
                      canResolve={false}
                      showTerm={false}
                      onResolved={handleConflictResolved}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
