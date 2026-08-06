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
  'ワ', 'ヲ',
] as const;

/**
 * 伝統的な五十音図の形（10列 × 5行）。ヤ行・ワ行の欠けているマスは null。
 * 「ん」は表からあえて外し（マス目に収まらないため）、ヲに含める（ユーザー指定。
 * 頭文字が「ん」の語は実際には非常に少ないため）。
 */
export const GOJUON_GRID: readonly (Bucket | null)[][] = [
  ['ア', 'カ', 'サ', 'タ', 'ナ', 'ハ', 'マ', 'ヤ', 'ラ', 'ワ'],
  ['イ', 'キ', 'シ', 'チ', 'ニ', 'ヒ', 'ミ', null, 'リ', null],
  ['ウ', 'ク', 'ス', 'ツ', 'ヌ', 'フ', 'ム', 'ユ', 'ル', null],
  ['エ', 'ケ', 'セ', 'テ', 'ネ', 'ヘ', 'メ', null, 'レ', null],
  ['オ', 'コ', 'ソ', 'ト', 'ノ', 'ホ', 'モ', 'ヨ', 'ロ', 'ヲ'],
];

/** 数字で始まる語のバケット */
export const NUMERIC_BUCKET = '数字';

/**
 * どのバケットにも分類できなかった語の受け皿（2026-08-06追加）。
 * 以前はこれを `0-9` に落としていたが、数字始まりでもない語が「0-9」の見出しの下に並ぶのは
 * 実態と食い違うため分離した（ユーザー指摘）。**該当する語が1件も無い場合は画面に出さない**
 * ——本来は空であるべき例外用のバケットで、常時見えていると索引の見た目を無駄に汚すため。
 */
export const OTHER_BUCKET = 'その他';

/** 「単語一覧」画面（索引）の頭文字バケット。英字→カナ（清音。濁点等は清音にまとめる）→数字→その他の順 */
export const BUCKET_ORDER = [
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
  'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
  ...KANA_BASE_CHARS,
  NUMERIC_BUCKET,
  OTHER_BUCKET,
] as const;

export type Bucket = (typeof BUCKET_ORDER)[number];

// 濁点・半濁点・拗音・促音・小書き母音は、対応する清音1文字にまとめる（ユーザー指定）。
// 「ん」は独立したバケットにせず、ヲに含める（頭文字が「ん」の語は稀なため。ユーザー指定）。
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
  ヲ: 'をん',
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
 * - 先頭文字が数字 → '数字'
 * - 先頭文字がかな（ひらがな・カタカナ） → 対応する清音1文字（濁点・半濁点・拗音・促音・
 *   小書き母音は清音にまとめる）
 * - それ以外（漢字・ー等） → readings[0] の先頭文字（常にカタカナ）から同様に判定。
 * - それでも判定できない場合（読みが無い・読みも記号始まり等の想定外データ） → 'その他'。
 *   以前はここを '0-9' に落としていたが、数字と無関係な語が数字の見出しに並ぶため分離した。
 */
export function bucketOf(term: TermRecord): Bucket {
  const first = term.term[0] ?? '';
  if (/[A-Za-z]/.test(first)) return first.toUpperCase() as Bucket;
  if (/[0-9]/.test(first)) return NUMERIC_BUCKET;

  const direct = kanaBaseOf(first);
  if (direct) return direct;

  const readingFirst = term.readings[0]?.[0];
  const readingBase = readingFirst ? kanaBaseOf(readingFirst) : undefined;
  return readingBase ?? OTHER_BUCKET;
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
