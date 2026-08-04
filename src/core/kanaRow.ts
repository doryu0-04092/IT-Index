import type { TermRecord } from '../types';

const KANA_BASE_CHARS = [
  'ア', 'イ', 'ウ', 'エ', 'オ',
  'カ', 'キ', 'ク', 'ケ', 'コ',
  'サ', 'シ', 'ス', 'セ', 'ソ',
  'タ', 'チ', 'ツ', 'テ', 'ト',
  'ナ', 'ニ', 'ヌ', 'ネ', 'ノ',
  'ハ', 'ヒ', 'フ', 'ヘ', 'ホ',
  'マ', 'ミ', 'ム', 'メ', 'モ',
  'ヤ', 'ユ', 'ヨ',
  'ラ', 'リ', 'ル', 'レ', 'ロ',
  'ワ', 'ヲ', 'ン',
] as const;

/** 「単語一覧」画面（索引）の頭文字バケット。A〜Z→0-9→清音（ア〜ン、濁点等は清音にまとめる）の順で並べる */
export const BUCKET_ORDER = [
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
  'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
  '0-9',
  ...KANA_BASE_CHARS,
] as const;

export type Bucket = (typeof BUCKET_ORDER)[number];

// 濁点・半濁点・拗音・促音・小書き母音は、対応する清音1文字にまとめる（ユーザー指定）。
// 「ん」「を」は清音では無いが、五十音図の独立した1マスとして単独バケットにする。
const BASE_CHARS: Record<string, string> = {
  ア: 'あぁ',
  イ: 'いぃ',
  ウ: 'うぅゔ',
  エ: 'えぇ',
  オ: 'おぉ',
  カ: 'かが',
  キ: 'きぎ',
  ク: 'くぐ',
  ケ: 'けげ',
  コ: 'こご',
  サ: 'さざ',
  シ: 'しじ',
  ス: 'すず',
  セ: 'せぜ',
  ソ: 'そぞ',
  タ: 'ただ',
  チ: 'ちぢ',
  ツ: 'つづっ',
  テ: 'てで',
  ト: 'とど',
  ナ: 'な',
  ニ: 'に',
  ヌ: 'ぬ',
  ネ: 'ね',
  ノ: 'の',
  ハ: 'はばぱ',
  ヒ: 'ひびぴ',
  フ: 'ふぶぷ',
  ヘ: 'へべぺ',
  ホ: 'ほぼぽ',
  マ: 'ま',
  ミ: 'み',
  ム: 'む',
  メ: 'め',
  モ: 'も',
  ヤ: 'やゃ',
  ユ: 'ゆゅ',
  ヨ: 'よょ',
  ラ: 'ら',
  リ: 'り',
  ル: 'る',
  レ: 'れ',
  ロ: 'ろ',
  ワ: 'わゎ',
  ヲ: 'を',
  ン: 'ん',
};

const CHAR_TO_BASE = new Map<string, Bucket>();
for (const [base, chars] of Object.entries(BASE_CHARS)) {
  for (const ch of chars) CHAR_TO_BASE.set(ch, base as Bucket);
}

/** カタカナ（U+30A1-U+30F6）→ ひらがな（U+3041-U+3096）。ー（長音符）等の非対応文字はそのまま返す */
function toHiraganaChar(ch: string): string {
  const code = ch.charCodeAt(0);
  return code >= 0x30a1 && code <= 0x30f6 ? String.fromCharCode(code - 0x60) : ch;
}

/** かな1文字を清音1文字のバケットにマッピングする。かな以外・非対応文字（ーなど）は undefined */
function kanaBaseOf(ch: string): Bucket | undefined {
  return CHAR_TO_BASE.get(toHiraganaChar(ch));
}

/**
 * 単語一覧（索引）用のバケット分類。
 * - 先頭文字がラテン文字 → その大文字（A〜Z）
 * - 先頭文字が数字 → '0-9'
 * - 先頭文字がかな（ひらがな・カタカナ） → 対応する清音1文字（濁点・半濁点・拗音・促音・
 *   小書き母音は清音にまとめる）
 * - それ以外（漢字・ー等） → readings[0] の先頭文字（常にカタカナ）から同様に判定。
 *   それでも判定できない場合（想定外データ）は '0-9' に落とす。
 */
export function bucketOf(term: TermRecord): Bucket {
  const first = term.term[0] ?? '';
  if (/[A-Za-z]/.test(first)) return first.toUpperCase() as Bucket;
  if (/[0-9]/.test(first)) return '0-9';

  const direct = kanaBaseOf(first);
  if (direct) return direct;

  const readingFirst = term.readings[0]?.[0];
  const readingBase = readingFirst ? kanaBaseOf(readingFirst) : undefined;
  return readingBase ?? '0-9';
}

/** バケットごとに語をまとめ、各バケット内は読み（次点で見出し語）の昇順に並べる */
export function groupIntoBuckets(terms: TermRecord[]): Map<Bucket, TermRecord[]> {
  const map = new Map<Bucket, TermRecord[]>(BUCKET_ORDER.map((b) => [b, []]));
  for (const term of terms) {
    map.get(bucketOf(term))!.push(term);
  }
  for (const bucketTerms of map.values()) {
    bucketTerms.sort((a, b) => {
      const readingCompare = a.readings[0].localeCompare(b.readings[0], 'ja');
      return readingCompare !== 0 ? readingCompare : a.term.localeCompare(b.term, 'ja');
    });
  }
  return map;
}
