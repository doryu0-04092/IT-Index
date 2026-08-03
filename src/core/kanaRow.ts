import type { TermRecord } from '../types';

/** 「単語一覧」画面（索引）の頭文字バケット。A〜Z→0-9→ア〜ワの順で並べる */
export const BUCKET_ORDER = [
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
  'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
  '0-9',
  'ア', 'カ', 'サ', 'タ', 'ナ', 'ハ', 'マ', 'ヤ', 'ラ', 'ワ',
] as const;

export type Bucket = (typeof BUCKET_ORDER)[number];

// 濁点・半濁点・小書き文字は清音と同じ行にまとめる。「ん」は慣例的にワ行に含める。
const ROW_CHARS: Record<string, string> = {
  ア: 'あぁいぃうぅゔえぇおぉ',
  カ: 'かがきぎくぐけげこご',
  サ: 'さざしじすずせぜそぞ',
  タ: 'ただちぢっつづてでとど',
  ナ: 'なにぬねの',
  ハ: 'はばぱひびぴふぶぷへべぺほぼぽ',
  マ: 'まみむめも',
  ヤ: 'やゃゆゅよょ',
  ラ: 'らりるれろ',
  ワ: 'わをんゎ',
};

const CHAR_TO_ROW = new Map<string, Bucket>();
for (const [row, chars] of Object.entries(ROW_CHARS)) {
  for (const ch of chars) CHAR_TO_ROW.set(ch, row as Bucket);
}

/** カタカナ（U+30A1-U+30F6）→ ひらがな（U+3041-U+3096）。ー（長音符）等の非対応文字はそのまま返す */
function toHiraganaChar(ch: string): string {
  const code = ch.charCodeAt(0);
  return code >= 0x30a1 && code <= 0x30f6 ? String.fromCharCode(code - 0x60) : ch;
}

/** かな1文字を五十音の行にマッピングする。かな以外・非対応文字（ーなど）は undefined */
function kanaRowOf(ch: string): Bucket | undefined {
  return CHAR_TO_ROW.get(toHiraganaChar(ch));
}

/**
 * 単語一覧（索引）用のバケット分類。
 * - 先頭文字がラテン文字 → その大文字（A〜Z）
 * - 先頭文字が数字 → '0-9'
 * - 先頭文字がかな（ひらがな・カタカナ） → その行（ア〜ワ）
 * - それ以外（漢字・ー等） → readings[0] の先頭文字（常にカタカナ）から行を判定。
 *   それでも判定できない場合（想定外データ）は '0-9' に落とす。
 */
export function bucketOf(term: TermRecord): Bucket {
  const first = term.term[0] ?? '';
  if (/[A-Za-z]/.test(first)) return first.toUpperCase() as Bucket;
  if (/[0-9]/.test(first)) return '0-9';

  const directRow = kanaRowOf(first);
  if (directRow) return directRow;

  const readingFirst = term.readings[0]?.[0];
  const readingRow = readingFirst ? kanaRowOf(readingFirst) : undefined;
  return readingRow ?? '0-9';
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
