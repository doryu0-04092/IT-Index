/**
 * 検索・id生成に使う正規化。v1の src/core/normalize.ts から変更なしで移植
 * (Phase 0ではCIパイプラインの検証対象を兼ねる。docs/v2/architecture.md §8)。
 *
 * docs/requirements.md §5.1「第1段」の3ルールに加え、
 * 同§5.1が明示する「漢数字 | 三層 ↔ 3層 | 1文字差」の例をスコアリングで拾えるようにするための
 * 漢数字→算用数字変換を行う(#36対応。この変換が無いと2-gram Dice係数が完全に0になり
 * 一致しなかった)。
 * - ひらがな ⇄ カタカナ を統一(ひらがなに寄せる)
 * - 全角 ⇄ 半角(英数記号)を統一(半角に寄せる)
 * - 英字の大小を無視(小文字に寄せる)
 * - 0〜9の単純な漢数字を算用数字に統一する(「十」「百」等の位取り文字は対象外。
 *   要件定義書の例が単純な1桁ケースのみのため、スコープを広げすぎない)
 *
 * 長音・記号・送り仮名の揺れは意図的にここでは吸収しない(score() のスコアリングに委ねる)。
 */
export function normalize(input: string): string {
  return toHiragana(toHalfWidthAlnumSymbols(toArabicDigits(input))).toLowerCase();
}

const KANJI_TO_ARABIC_DIGIT: Record<string, string> = {
  〇: '0',
  零: '0',
  一: '1',
  二: '2',
  三: '3',
  四: '4',
  五: '5',
  六: '6',
  七: '7',
  八: '8',
  九: '9',
};

function toArabicDigits(s: string): string {
  return s.replace(/[〇零一二三四五六七八九]/g, (ch) => KANJI_TO_ARABIC_DIGIT[ch]);
}

function toHalfWidthAlnumSymbols(s: string): string {
  return s
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ');
}

function toHiragana(s: string): string {
  // カタカナ(U+30A1-U+30F6)→ ひらがな(U+3041-U+3096)
  return s.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}
