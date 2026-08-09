import type { TermRecord } from '../types';
import { normalize } from './normalize';

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

/** 読みの先頭文字から決まるバケット。読みが無い・かな以外で始まる場合は undefined */
function readingBucketOf(term: TermRecord): Bucket | undefined {
  const readingFirst = term.readings[0]?.[0];
  return readingFirst ? kanaBaseOf(readingFirst) : undefined;
}

/**
 * 単語一覧（索引）用のバケット分類（表記から決まる主バケット）。
 * - 先頭文字がラテン文字 → その大文字（A〜Z）
 * - 先頭文字が数字 → '数字'
 * - 先頭文字がかな（ひらがな・カタカナ） → 対応する清音1文字（濁点・半濁点・拗音・促音・
 *   小書き母音は清音にまとめる）
 * - それ以外（漢字・記号・ー等） → readings[0] の先頭文字（常にカタカナ）から同様に判定。
 * - それでも判定できない場合（読みが無い・読みも記号始まり等の想定外データ） → 'その他'。
 *   以前はここを '0-9' に落としていたが、数字と無関係な語が数字の見出しに並ぶため分離した。
 *
 * 2026-08-07: 先頭文字の判定を `normalize()` を通した後で行うようにした。それまでは生の文字で
 * 判定していたため、全角数字「３Dプリンタ」や漢数字「一次キャッシュ」が数字と見なされず、
 * 読み経由で無関係な行（サ行・イ行）に入っていた。検索は `normalize()` を通すのに索引だけ
 * 通していないという基準の二重化が原因で、揃えることで解消した（実データで確認済み）。
 */
export function bucketOf(term: TermRecord): Bucket {
  // 全角→半角・漢数字→算用数字・カタカナ→ひらがな・英大文字→小文字がここで揃う
  const first = normalize(term.term[0] ?? '');
  if (/[a-z]/.test(first)) return first.toUpperCase() as Bucket;
  if (/[0-9]/.test(first)) return NUMERIC_BUCKET;

  const direct = kanaBaseOf(first);
  if (direct) return direct;

  return readingBucketOf(term) ?? OTHER_BUCKET;
}

/**
 * その語を索引のどの見出しに載せるか（複数可）。
 *
 * 数字始まりの語だけは**読みの行にも重ねて載せる**（2026-08-07。国語辞典の「空見出し」と
 * 同じ考え方）。「1」を「ワン」として覚えている利用者がワ行を見ても見つからない、表記から
 * しか辿れない一方通行だったため（実際に報告された不具合）。重複させる対象を数字始まりに
 * 限っているのは、英字始まり（例: CPU＝シーピーユー）まで広げると索引全体が膨らむわりに
 * 得るものが少ないため——数字始まりは「見出しの文字」と「読みの頭」が食い違うことが常で、
 * ここだけが実際に困る。
 */
export function bucketsOf(term: TermRecord): Bucket[] {
  const primary = bucketOf(term);
  if (primary !== NUMERIC_BUCKET) return [primary];
  const reading = readingBucketOf(term);
  return reading && reading !== primary ? [primary, reading] : [primary];
}

/** 読みが無い想定外データでも落ちないようにする（下の compareByReading の注記を参照） */
function readingOf(term: TermRecord): string {
  return term.readings[0] ?? '';
}

/**
 * 既定の並び（読み→見出し語の昇順）。
 *
 * `readings[0]` を直接触っていたため、読みが空の語が1件でも他の語と同じバケットに入ると
 * `undefined.localeCompare` で例外になり、**単語一覧の画面全体が「読み込み中です…」のまま
 * 停止していた**（2026-08-07に実データで再現・修正）。分類の失敗が索引全体の停止に化ける
 * のは影響が大きすぎるため、ここでは必ず既定値に倒す。
 */
function compareByReading(a: TermRecord, b: TermRecord): number {
  const readingCompare = readingOf(a).localeCompare(readingOf(b), 'ja');
  return readingCompare !== 0 ? readingCompare : a.term.localeCompare(b.term, 'ja');
}

/** 表記の先頭に並ぶ数字を数値として取り出す。数字始まりでなければ value は Infinity */
function numericPrefixOf(term: TermRecord): { value: number; hasRest: boolean } {
  const matched = /^(\d+)(.*)$/.exec(normalize(term.term));
  if (!matched) return { value: Number.POSITIVE_INFINITY, hasRest: true };
  return { value: Number(matched[1]), hasRest: matched[2] !== '' };
}

/**
 * 「数字」バケット専用の並び。**数値の昇順**にする（同じ数値なら数字だけの語を先に、
 * 次に読み順）。
 *
 * 他のバケットと同じ読み順にしていたため、「1」（読み: ワン）が数字バケットの37件中37番目、
 * 「4P」の後ろに置かれ、見出しを開いても見つけられなかった（2026-08-07に実データで確認）。
 * 数字の見出しの下では、利用者は読みではなく数の並びで探すため、ここだけ基準を変える。
 */
function compareInNumericBucket(a: TermRecord, b: TermRecord): number {
  const ka = numericPrefixOf(a);
  const kb = numericPrefixOf(b);
  if (ka.value !== kb.value) return ka.value - kb.value;
  // 「1」を「1アドレス方式」より先に出す（数字だけの語がその数のいちばん上に来る）
  if (ka.hasRest !== kb.hasRest) return ka.hasRest ? 1 : -1;
  return compareByReading(a, b);
}

/** バケットごとに語をまとめて並べる。数字始まりの語は読みの行にも重ねて載る（bucketsOf参照） */
export function groupIntoBuckets(terms: TermRecord[]): Map<Bucket, TermRecord[]> {
  const map = new Map<Bucket, TermRecord[]>(BUCKET_ORDER.map((b) => [b, []]));
  for (const term of terms) {
    for (const bucket of bucketsOf(term)) map.get(bucket)!.push(term);
  }
  for (const [bucket, bucketTerms] of map) {
    bucketTerms.sort(bucket === NUMERIC_BUCKET ? compareInNumericBucket : compareByReading);
  }
  return map;
}
