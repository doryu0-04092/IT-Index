import { useEffect, useMemo, useState } from 'react';
import { computeWeights } from '../../core/computeWeights';
import type { AsksRepository } from '../../repositories/asks';
import type { ChatRepository } from '../../repositories/chat';
import type { SyncEventsRepository } from '../../repositories/syncEvents';
import type { TermsRepository } from '../../repositories/terms';
import type { AskRecord, ChatSessionRecord, SyncEventRecord, TermRecord } from '../../types';

export type HistoryView = 'weighted' | 'timeline' | 'sync' | 'commits';

interface ChatHistoryRow {
  session: ChatSessionRecord;
  /** 語ひも付きなら見出し語、「AIで検索」なら入力した文字列 */
  label: string;
}

export interface HistoryScreenProps {
  asksRepo: AsksRepository;
  termsRepo: TermsRepository;
  syncEventsRepo: SyncEventsRepository;
  chatRepo: ChatRepository;
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

/**
 * 要件定義書§5.4「重み付けビュー／時系列ビュー」。元は別画面だったが、
 * 1画面でタブ切り替えできるように統合した（2026-07-28）。
 * データ取得（asks・term引き当て）は共通化し、並べ替え・表示だけをタブごとに分ける。
 *
 * 「連携履歴」タブ（2026-08-05追加、2026-08-06改名）は連携（QR）で新しく受け取った／渡した
 * 単語の記録。デバイスに名前を付ける機能が無いため、相手を「端末XXXX」のように名指しはせず、
 * 「この連携で受け取った／渡した」という関係性だけで表記する（ユーザー指示）。
 *
 * 「取り込み履歴」タブ（2026-08-06新設）はAIチャットの記録。取り込み済み・登録しなかった・
 * 取り込み待ちのいずれも時系列（最近やり取りした順）で並べる。押すと単語詳細ではなく
 * そのチャットを開く——取り込んでいないものはそこから改めて取り込め、登録しなかったものも
 * 後から気が変わって取り込み直せる（`ChatRepository`の30件上限・declined状態を参照）。
 */
export default function HistoryScreen({
  asksRepo,
  termsRepo,
  syncEventsRepo,
  chatRepo,
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

  useEffect(() => {
    (async () => {
      const allAsks = await asksRepo.getAllOrdered();
      setAsks(allAsks);

      const events = await syncEventsRepo.getAllOrdered();
      setSyncEvents(events);

      const sessions = await chatRepo.getRecentSessions(30);
      const rows: ChatHistoryRow[] = [];
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
  }, [asksRepo, termsRepo, syncEventsRepo, chatRepo]);

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
      ) : (
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
      )}
    </div>
  );
}
