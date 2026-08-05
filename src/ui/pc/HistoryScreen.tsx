import { useEffect, useMemo, useState } from 'react';
import { computeWeights } from '../../core/computeWeights';
import type { AsksRepository } from '../../repositories/asks';
import type { SyncEventsRepository } from '../../repositories/syncEvents';
import type { TermsRepository } from '../../repositories/terms';
import type { AskRecord, SyncEventRecord, TermRecord } from '../../types';

export type HistoryView = 'weighted' | 'timeline' | 'sync';

export interface HistoryScreenProps {
  asksRepo: AsksRepository;
  termsRepo: TermsRepository;
  syncEventsRepo: SyncEventsRepository;
  initialView: HistoryView;
  onSelectTerm: (termId: string) => void;
  onBack: () => void;
}

/**
 * 要件定義書§5.4「重み付けビュー／時系列ビュー」。元は別画面だったが、
 * 1画面でタブ切り替えできるように統合した（2026-07-28）。
 * データ取得（asks・term引き当て）は共通化し、並べ替え・表示だけをタブごとに分ける。
 *
 * 「取り込み履歴」タブ（2026-08-05追加）は連携（QR）で新しく受け取った／渡した単語の記録。
 * デバイスに名前を付ける機能が無いため、相手を「端末XXXX」のように名指しはせず、
 * 「この連携で受け取った／渡した」という関係性だけで表記する（ユーザー指示）。
 */
export default function HistoryScreen({ asksRepo, termsRepo, syncEventsRepo, initialView, onSelectTerm, onBack }: HistoryScreenProps) {
  const [view, setView] = useState<HistoryView>(initialView);
  const [asks, setAsks] = useState<AskRecord[]>([]);
  const [termsById, setTermsById] = useState<Map<string, TermRecord>>(new Map());
  const [syncEvents, setSyncEvents] = useState<SyncEventRecord[]>([]);

  useEffect(() => {
    (async () => {
      const allAsks = await asksRepo.getAllOrdered();
      setAsks(allAsks);

      const events = await syncEventsRepo.getAllOrdered();
      setSyncEvents(events);

      const uniqueTermIds = new Set(allAsks.map((a) => a.termId));
      for (const e of events) {
        e.receivedTermIds.forEach((id) => uniqueTermIds.add(id));
        e.sentTermIds.forEach((id) => uniqueTermIds.add(id));
      }
      const terms = await Promise.all([...uniqueTermIds].map((id) => termsRepo.getById(id)));
      const map = new Map<string, TermRecord>();
      for (const t of terms) if (t) map.set(t.id, t);
      setTermsById(map);
    })();
  }, [asksRepo, termsRepo, syncEventsRepo]);

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
      ) : (
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
      )}
    </div>
  );
}
