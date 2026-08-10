import { FIELDS, type Field } from '@it-index/shared';
import { extractJson } from './extractJson';

/**
 * 分配統合のAI出力1項目(v1 ../../../src/ai/parseDistribution.ts参照)。isTermによって
 * 必須フィールドが変わるため判別共用体にする(isTerm:falseのノイズ項目にreadings/field/
 * draftBodyを持たせない)。
 */
export type DistributionItem =
  | {
      term: string;
      isTerm: true;
      /** ユーザー自身がこの語について明示的に尋ねたか。新規語登録の可否判定に使う(distribution.ts) */
      askedByUser: boolean;
      /** 新規語登録時のみ使う初期説明の一文。既存語では無視する */
      summary: string;
      readings: string[];
      field: Field;
      draftBody: string;
      diagrams: string[];
    }
  | { term: string; isTerm: false; diagrams: string[] };

export type ParseDistributionResult = { ok: true; items: DistributionItem[] } | { ok: false; reason: string };

/**
 * termは見出し語・熟語であることが前提(prompts.tsの指示)。この長さを超える場合、ユーザーの
 * 質問文をそのまま複写した誤りである可能性が高いため拒否する(v1で実際に報告された不具合)。
 */
const MAX_TERM_LENGTH = 40;

export function parseDistributionResponse(raw: string): ParseDistributionResult {
  let data: unknown;
  try {
    data = JSON.parse(extractJson(raw));
  } catch {
    return { ok: false, reason: 'JSONとして解釈できませんでした' };
  }

  if (!Array.isArray(data)) {
    return { ok: false, reason: 'ルート要素が配列ではありません' };
  }

  const items: DistributionItem[] = [];
  for (let i = 0; i < data.length; i++) {
    const entry = data[i];
    if (typeof entry !== 'object' || entry === null) {
      return { ok: false, reason: `items[${i}] がオブジェクトではありません` };
    }
    const e = entry as Record<string, unknown>;

    if (typeof e.term !== 'string' || e.term === '') {
      return { ok: false, reason: `items[${i}].term がありません` };
    }
    if (e.term.length > MAX_TERM_LENGTH) {
      return {
        ok: false,
        reason: `items[${i}].term が長すぎます(見出し語ではなく質問文になっている可能性があります): ${e.term}`,
      };
    }
    if (typeof e.isTerm !== 'boolean') {
      return { ok: false, reason: `${e.term}: isTerm が boolean ではありません` };
    }

    const diagrams = e.diagrams ?? [];
    if (!Array.isArray(diagrams) || !diagrams.every((d) => typeof d === 'string')) {
      return { ok: false, reason: `${e.term}: diagrams が不正です` };
    }

    if (!e.isTerm) {
      items.push({ term: e.term, isTerm: false, diagrams: diagrams as string[] });
      continue;
    }

    if (typeof e.askedByUser !== 'boolean') {
      return { ok: false, reason: `${e.term}: askedByUser が boolean ではありません` };
    }
    if (typeof e.summary !== 'string' || e.summary === '') {
      return { ok: false, reason: `${e.term}: summary がありません` };
    }
    // 空文字の読みも弾く(v1 2026-08-07対応と同じ理由。読みが実質無い語は索引描画で例外になる)
    if (
      !Array.isArray(e.readings) ||
      e.readings.length === 0 ||
      !e.readings.every((r) => typeof r === 'string' && r.trim() !== '')
    ) {
      return { ok: false, reason: `${e.term}: readings が不正です(空でない文字列を1要素以上含む配列が必要)` };
    }
    if (typeof e.field !== 'string' || !(FIELDS as readonly string[]).includes(e.field)) {
      return { ok: false, reason: `${e.term}: field が一覧にありません: ${String(e.field)}` };
    }
    if (typeof e.draftBody !== 'string' || e.draftBody === '') {
      return { ok: false, reason: `${e.term}: draftBody がありません` };
    }

    items.push({
      term: e.term,
      isTerm: true,
      askedByUser: e.askedByUser,
      summary: e.summary,
      readings: e.readings as string[],
      field: e.field as Field,
      draftBody: e.draftBody,
      diagrams: diagrams as string[],
    });
  }

  return { ok: true, items };
}
