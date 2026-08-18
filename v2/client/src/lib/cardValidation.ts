/**
 * クレジットカード入力のフロント側検証・整形(要件定義書§4.2「決済はモック」)。
 * チェックアウト画面(screens/CheckoutScreen.tsx)のフォームが使う純関数のみを置く。
 * カード情報はサーバーへ一切送らないため、検証はここで完結する(本人指定:
 * 「サーバーチェックは行わず、必要な購入情報がすべて正しく入力されているかだけ確認する」)。
 * DOM・React非依存で、単体テスト(cardValidation.test.ts)から直接呼べる。
 */

export type CardBrand = 'visa' | 'mastercard' | 'amex' | 'jcb' | 'unknown';

/** ブランド別のカード番号桁数(amexのみ15桁、他は16桁で扱う) */
function maxDigitsFor(brand: CardBrand): number {
  return brand === 'amex' ? 15 : 16;
}

/**
 * 先頭の数字でブランドを判定する。判定素材が足りない入力途中は'unknown'を返す。
 * 4→Visa / 51-55・2221-2720→Mastercard / 34・37→Amex / 35→JCB。
 */
export function detectBrand(digits: string): CardBrand {
  if (/^4/.test(digits)) return 'visa';
  if (/^5[1-5]/.test(digits)) return 'mastercard';
  if (digits.length >= 4) {
    const head4 = Number(digits.slice(0, 4));
    if (head4 >= 2221 && head4 <= 2720) return 'mastercard';
  }
  if (/^3[47]/.test(digits)) return 'amex';
  if (/^35/.test(digits)) return 'jcb';
  return 'unknown';
}

/** 入力から数字以外を取り除き、ブランド別の最大桁数(amex:15/他:16)に丸める */
export function normalizeCardNumber(input: string): string {
  const digits = input.replace(/\D/g, '');
  return digits.slice(0, maxDigitsFor(detectBrand(digits)));
}

/**
 * カード番号を空白区切りに整形する(Visa等: 4-4-4-4、Amex: 4-6-5)。
 * 入力途中の桁数でも安全に動く(末尾の区切りは付けない)。
 */
export function formatCardNumber(digits: string): string {
  const groups =
    detectBrand(digits) === 'amex'
      ? [digits.slice(0, 4), digits.slice(4, 10), digits.slice(10, 15)]
      : [digits.slice(0, 4), digits.slice(4, 8), digits.slice(8, 12), digits.slice(12, 16)];
  return groups.filter((g) => g !== '').join(' ');
}

/** Luhnアルゴリズムによるチェックディジット検証。桁数の妥当性はここでは見ない */
export function luhnCheck(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/** カード番号の総合判定(ブランド別の桁数が揃っている+Luhnが通る) */
export function validateCardNumber(digits: string): boolean {
  return digits.length === maxDigitsFor(detectBrand(digits)) && luhnCheck(digits);
}

/**
 * 有効期限入力の自動整形。数字だけを拾い、3桁目以降が入った時点で"MM/YY"の形にする
 * ("1225"→"12/25")。2桁以下ではスラッシュを付けない——2桁目の入力直後に付けると、
 * バックスペースでスラッシュを消しても次の再整形で復活し、月の2桁目が消せなくなるため。
 */
export function formatExpiry(input: string): string {
  const digits = input.replace(/\D/g, '').slice(0, 4);
  if (digits.length <= 2) return digits;
  return `${digits.slice(0, 2)}/${digits.slice(2)}`;
}

/**
 * 有効期限の判定。"MM/YY"形式・月01-12・当月以降(カードは記載月の末日まで有効)のとき真。
 * nowはテストから固定日時を注入するための引数で、通常は現在時刻。
 */
export function validateExpiry(value: string, now: Date = new Date()): boolean {
  const match = /^(\d{2})\/(\d{2})$/.exec(value);
  if (!match) return false;
  const month = Number(match[1]);
  if (month < 1 || month > 12) return false;
  const year = 2000 + Number(match[2]);
  const nowYear = now.getFullYear();
  const nowMonth = now.getMonth() + 1;
  return year > nowYear || (year === nowYear && month >= nowMonth);
}

/** セキュリティコードの判定(Amex: 4桁、他ブランド: 3桁の数字) */
export function validateCvc(value: string, brand: CardBrand): boolean {
  return brand === 'amex' ? /^\d{4}$/.test(value) : /^\d{3}$/.test(value);
}
