import { extractJson } from './extractJson';

export interface MergeResult {
  body: string;
  diagrams: string[];
}

export type ParseMergeResult = { ok: true; result: MergeResult } | { ok: false; reason: string };

/** v1 ../../../src/ai/parseMerge.ts と同一 */
export function parseMergeResponse(raw: string): ParseMergeResult {
  let data: unknown;
  try {
    data = JSON.parse(extractJson(raw));
  } catch {
    return { ok: false, reason: 'JSONとして解釈できませんでした' };
  }

  if (typeof data !== 'object' || data === null) {
    return { ok: false, reason: 'ルート要素がオブジェクトではありません' };
  }
  const d = data as Record<string, unknown>;

  if (typeof d.body !== 'string' || d.body === '') {
    return { ok: false, reason: 'body がありません' };
  }
  const diagrams = d.diagrams ?? [];
  if (!Array.isArray(diagrams) || !diagrams.every((x) => typeof x === 'string')) {
    return { ok: false, reason: 'diagrams が不正です' };
  }

  return { ok: true, result: { body: d.body, diagrams: diagrams as string[] } };
}
