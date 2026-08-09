import { useEffect, useMemo, useState } from 'react';
import { computeWeights, type AskRecord, type TermRecord } from '@it-index/shared';
import type { AsksRepository } from '../repositories/asks';
import type { TermsRepository } from '../repositories/terms';

export interface WeightedScreenProps {
  asksRepo: AsksRepository;
  termsRepo: TermsRepository;
  onSelectTerm: (termId: string) => void;
}

/**
 * 要件定義書§4.1「重み付け(苦手分野の可視化)」。v1のHistoryScreen重み付けタブ
 * (../../../src/ui/pc/HistoryScreen.tsx)相当。asksの記録に@it-index/sharedの
 * computeWeights()をそのまま適用し、重い(=繰り返し聞いていて未定着)順に一覧表示する。
 * 削除済みの語は表示しない(termsRepo.getAll()が返す非tombstoneの語だけで絞り込む)。
 */
export default function WeightedScreen({ asksRepo, termsRepo, onSelectTerm }: WeightedScreenProps) {
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

  return (
    <div className="weighted-screen">
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
    </div>
  );
}
