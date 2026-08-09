import type { TermRecord } from '../types';
import { normalize } from './normalize';

export interface ScoredTerm {
  term: TermRecord;
  score: number;
}

/**
 * docs/requirements.md §5.1「第2段」。2-gram Dice係数を基礎に、
 * 完全一致／前方一致／部分一致で加点する。個別の表記ゆれルールは書かない。
 */
export function score(query: string, terms: TermRecord[]): ScoredTerm[] {
  const normalizedQuery = normalize(query);
  const scored = terms.map((term) => {
    const keys = [term.searchKey, ...term.readingKeys];
    const best = Math.max(...keys.map((key) => scoreAgainstKey(normalizedQuery, key)));
    return { term, score: best };
  });
  return scored.sort((a, b) => b.score - a.score);
}

function scoreAgainstKey(query: string, key: string): number {
  if (query.length === 0 || key.length === 0) return 0;
  let s = diceCoefficient(query, key);
  if (key === query) s += 1;
  else if (key.startsWith(query)) s += 0.5;
  else if (key.includes(query)) s += 0.25;
  return s;
}

function bigrams(s: string): string[] {
  if (s.length < 2) return s.length === 1 ? [s] : [];
  const grams: string[] = [];
  for (let i = 0; i < s.length - 1; i++) grams.push(s.slice(i, i + 2));
  return grams;
}

function diceCoefficient(a: string, b: string): number {
  const ga = bigrams(a);
  const gb = bigrams(b);
  if (ga.length === 0 || gb.length === 0) return a === b ? 1 : 0;

  const counts = new Map<string, number>();
  for (const g of ga) counts.set(g, (counts.get(g) ?? 0) + 1);

  let intersection = 0;
  for (const g of gb) {
    const c = counts.get(g) ?? 0;
    if (c > 0) {
      intersection++;
      counts.set(g, c - 1);
    }
  }
  return (2 * intersection) / (ga.length + gb.length);
}
