import type { AskRecord } from '../types';

export interface WeightedTerm {
  termId: string;
  weight: number;
}

/**
 * docs/requirements.md §5.4 の式をそのまま実装する。
 *
 *   score(語) = Σ r^(N-i)   r = 0.5^(1/H)
 *
 * 通し番号 i は (at, id) の複合キーで決める（時刻だけでは端末間でずれるため id をタイブレークに使う）。
 * N は全体の質問総数。H は半減期（既定50問）。
 */
export function computeWeights(asks: AskRecord[], halfLife = 50): WeightedTerm[] {
  const sorted = [...asks].sort((a, b) => a.at - b.at || compareId(a.id, b.id));
  const n = sorted.length;
  const r = Math.pow(0.5, 1 / halfLife);

  const totals = new Map<string, number>();
  sorted.forEach((ask, idx) => {
    const i = idx + 1; // 1-indexed通し番号
    const weight = Math.pow(r, n - i);
    totals.set(ask.termId, (totals.get(ask.termId) ?? 0) + weight);
  });

  return [...totals.entries()]
    .map(([termId, weight]) => ({ termId, weight }))
    .sort((a, b) => b.weight - a.weight);
}

function compareId(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
