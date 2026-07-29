import { useEffect, useMemo, useState } from 'react';
import { computeWeights } from '../../core/computeWeights';
import type { AsksRepository } from '../../repositories/asks';
import type { TermsRepository } from '../../repositories/terms';
import type { AskRecord, TermRecord } from '../../types';

export type HistoryView = 'weighted' | 'timeline';

export interface HistoryScreenProps {
  asksRepo: AsksRepository;
  termsRepo: TermsRepository;
  initialView: HistoryView;
  onSelectTerm: (termId: string) => void;
  onBack: () => void;
}

/**
 * 要件定義書§5.4「重み付けビュー／時系列ビュー」。元は別画面だったが、
 * 1画面でタブ切り替えできるように統合した（2026-07-28）。
 * データ取得（asks・term引き当て）は共通化し、並べ替え・表示だけをタブごとに分ける。
 */
export default function HistoryScreen({ asksRepo, termsRepo, initialView, onSelectTerm, onBack }: HistoryScreenProps) {
  const [view, setView] = useState<HistoryView>(initialView);
  const [asks, setAsks] = useState<AskRecord[]>([]);
  const [termsById, setTermsById] = useState<Map<string, TermRecord>>(new Map());

  useEffect(() => {
    (async () => {
      const allAsks = await asksRepo.getAllOrdered();
      setAsks(allAsks);

      const uniqueTermIds = [...new Set(allAsks.map((a) => a.termId))];
      const terms = await Promise.all(uniqueTermIds.map((id) => termsRepo.getById(id)));
      const map = new Map<string, TermRecord>();
      for (const t of terms) if (t) map.set(t.id, t);
      setTermsById(map);
    })();
  }, [asksRepo, termsRepo]);

  const weightedRows = useMemo(
    () =>
      computeWeights(asks)
        .map((w) => ({ term: termsById.get(w.termId), weight: w.weight }))
        .filter((r): r is { term: TermRecord; weight: number } => r.term !== undefined),
    [asks, termsById],
  );

  const timelineRows = useMemo(
    () =>
      asks
        .map((ask) => ({ ask, term: termsById.get(ask.termId) }))
        .filter((r): r is { ask: AskRecord; term: TermRecord } => r.term !== undefined)
        .sort((a, b) => b.ask.at - a.ask.at),
    [asks, termsById],
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
      </nav>

      {view === 'weighted' ? (
        <>
          <p className="search-status">最近も繰り返し聞いている語ほど上位（＝まだ定着していない語）</p>
          {weightedRows.length === 0 && <p className="search-status">まだ記録がありません。</p>}
          <ul className="search-results">
            {weightedRows.map(({ term, weight }) => (
              <li key={term.id}>
                <button type="button" className="search-result" onClick={() => onSelectTerm(term.id)}>
                  <span className="search-result-term">{term.term}</span>
                  <span className="search-result-reading">{term.readings[0]}</span>
                  <span className="search-result-score">{weight.toFixed(2)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          {timelineRows.length === 0 && <p className="search-status">まだ記録がありません。</p>}
          <ul className="search-results">
            {timelineRows.map(({ ask, term }) => (
              <li key={ask.id}>
                <button type="button" className="search-result" onClick={() => onSelectTerm(term.id)}>
                  <span className="search-result-term">{term.term}</span>
                  <span className="search-result-field">{new Date(ask.at).toLocaleString('ja-JP')}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
