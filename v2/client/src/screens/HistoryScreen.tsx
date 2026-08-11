import { useEffect, useMemo, useState } from 'react';
import { computeWeights, type AskRecord, type TermRecord } from '@it-index/shared';
import type { HistoryView } from '../navigation';
import type { AsksRepository } from '../repositories/asks';
import type { TermsRepository } from '../repositories/terms';

export interface HistoryScreenProps {
  asksRepo: AsksRepository;
  termsRepo: TermsRepository;
  view: HistoryView;
  onChangeView: (view: HistoryView) => void;
  onSelectTerm: (termId: string) => void;
}

const TABS: readonly { view: HistoryView; label: string }[] = [
  { view: 'timeline', label: '時系列' },
  { view: 'weighted', label: '重み付け' },
];

/**
 * 「履歴」タブ。重み付けは個人的に作った特殊な機能の1つに過ぎず、履歴としては
 * 時系列順が最低限の機能であるため(本人指定)、時系列を既定サブタブ・重み付けを
 * 2番目のサブタブとする。連携履歴・取り込み履歴・競合選択タブは将来ここにサブタブとして
 * 追加できるが、現時点では実装しない(要件外)。
 *
 * データ取得(asks・term引き当て)はサブタブ間で共通・1回だけ行う(旧WeightedScreen.tsxの
 * ロードを移植)。並べ替え・表示だけをサブタブごとに分ける。tombstone(削除済み)の語は
 * termsRepo.getAll()が非削除のみ返すため自然に除外される。
 */
export default function HistoryScreen({ asksRepo, termsRepo, view, onChangeView, onSelectTerm }: HistoryScreenProps) {
  const [asks, setAsks] = useState<AskRecord[]>([]);
  const [termsById, setTermsById] = useState<Map<string, TermRecord>>(new Map());

  useEffect(() => {
    void (async () => {
      setAsks(await asksRepo.getAllOrdered());
      const terms = await termsRepo.getAll();
      setTermsById(new Map(terms.map((t) => [t.id, t])));
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

  return (
    <div className="history-screen">
      <nav className="app-nav" aria-label="履歴の切り替え">
        {TABS.map((tab) => (
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
      ) : (
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
      )}
    </div>
  );
}
