import type { AskRecord } from '../types';

export interface WeightedTerm {
  termId: string;
  weight: number;
}

/**
 * AIチャットで確定した質問の重み。ローカル検索の確定より強く効かせる
 * （「AI検索をかけたもの＝分からなくて聞いた」という強いシグナルを優先する。2026-07-29決定）。
 */
const SOURCE_MULTIPLIER: Record<AskRecord['source'], number> = {
  ai: 3,
  search: 1,
};

/** この変更以前に作られた（source フィールドが無い）レコードは 'ai' 扱いにする（後方互換） */
function sourceMultiplierOf(ask: AskRecord): number {
  return SOURCE_MULTIPLIER[ask.source ?? 'ai'];
}

/**
 * docs/requirements.md §5.4 の式をそのまま実装する。
 *
 *   score(語) = Σ w_i · r^(N-i)   r = 0.5^(1/H)
 *
 * 通し番号 i は (at, id) の複合キーで決める（時刻だけでは端末間でずれるため id をタイブレークに使う）。
 * N は全体の質問総数（AIチャット確定・ローカル検索確定を合わせた通し番号）。H は半減期（既定50問）。
 * w_i はイベントごとの重み（SOURCE_MULTIPLIER。2026-07-29追加、それ以前は常に1）。
 */
export function computeWeights(asks: AskRecord[], halfLife = 50): WeightedTerm[] {
  const sorted = [...asks].sort((a, b) => a.at - b.at || compareId(a.id, b.id));
  const n = sorted.length;
  const r = Math.pow(0.5, 1 / halfLife);

  const totals = new Map<string, number>();
  sorted.forEach((ask, idx) => {
    const i = idx + 1; // 1-indexed通し番号
    const weight = sourceMultiplierOf(ask) * Math.pow(r, n - i);
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
