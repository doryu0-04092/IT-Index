/**
 * 検索・id生成に使う正規化。docs/requirements.md §5.1「第1段」の3ルールのみを行う。
 * - ひらがな ⇄ カタカナ を統一（ひらがなに寄せる）
 * - 全角 ⇄ 半角（英数記号）を統一（半角に寄せる）
 * - 英字の大小を無視（小文字に寄せる）
 *
 * 長音・記号・送り仮名の揺れは意図的にここでは吸収しない（score() のスコアリングに委ねる）。
 */
export function normalize(input: string): string {
  return toHiragana(toHalfWidthAlnumSymbols(input)).toLowerCase();
}

function toHalfWidthAlnumSymbols(s: string): string {
  return s
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ');
}

function toHiragana(s: string): string {
  // カタカナ（U+30A1-U+30F6）→ ひらがな（U+3041-U+3096）
  return s.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}
