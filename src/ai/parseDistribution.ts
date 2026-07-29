import { FIELDS, type Field } from '../types';
import { extractJson } from './extractJson';

/**
 * 分配統合のAI出力1項目。isTerm によって必須フィールドが変わるため判別共用体にする
 * （isTerm:false のノイズ項目に readings/field/draftBody を持たせない）。
 */
export type DistributionItem =
  | {
      term: string;
      isTerm: true;
      /** ユーザー自身がこの語について明示的に尋ねたか。新規語登録の可否判定に使う（distribution.ts） */
      askedByUser: boolean;
      /** 新規語登録時のみ使う初期説明の一文（要件定義書§5.2、2026-07-29追加）。既存語では無視する */
      summary: string;
      readings: string[];
      field: Field;
      draftBody: string;
      diagrams: string[];
    }
  | { term: string; isTerm: false; diagrams: string[] };

export type ParseDistributionResult = { ok: true; items: DistributionItem[] } | { ok: false; reason: string };

/**
 * docs/requirements.md §5.3「用語でないものを登録しないための2段の絞り込み」の1段目。
 * ここでAI出力の形式を検証する（2段目はUIでの承認）。
 */
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
    if (!Array.isArray(e.readings) || e.readings.length === 0 || !e.readings.every((r) => typeof r === 'string')) {
      return { ok: false, reason: `${e.term}: readings が不正です（1要素以上の文字列配列が必要）` };
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
