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
 * 要件定義書§5.4「重み付けビュー／時系列ビュー」（Android版）。
 * PC版と同じprops・同じロジック・同じCSSクラス名。狭幅でのタブ折り返しは
 * `.android-app .history-tabs` 側のCSS（src/index.css 末尾）で対応する。
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
      ) : (
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
      )}
    </div>
  );
}
