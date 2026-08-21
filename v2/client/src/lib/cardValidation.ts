/**
 * クレジットカード入力のフロント側検証・整形(要件定義書§4.2「決済はモック」)。
 * チェックアウト画面(screens/CheckoutScreen.tsx)のフォームが使う純関数のみを置く。
 * カード情報はサーバーへ一切送らないため、検証はここで完結する(本人指定:
 * 「サーバーチェックは行わず、必要な購入情報がすべて正しく入力されているかだけ確認する」)。
 * DOM・React非依存で、単体テスト(cardValidation.test.ts)から直接呼べる。
 *
 * 検証の厳しさはデモ用に意図的に緩めてある(本人指定 #139「数字さえ入力されていればよい。
 * 月だけ01〜12」)。当初あったLuhnチェック・有効期限の未来日チェックは、適当な数字での
 * デモ操作を弾いてしまうため廃止した。残しているのは「必要な情報が形として揃っているか」
 * (桁数・月の範囲・CVC桁数・名義非空)だけ。
 */

export type CardBrand = 'visa' | 'mastercard' | 'amex' | 'jcb' | 'unknown';

/**
 * ブランドの表示名(チェックアウトのバッジ・設定タブの「お支払い方法」で共用)。
 * unknownはバッジを出さない判断を呼び出し側でできるようnullを返す。
 */
export function brandLabel(brand: CardBrand): string | null {
  switch (brand) {
    case 'visa':
      return 'VISA';
    case 'mastercard':
      return 'Mastercard';
    case 'amex':
      return 'AMEX';
    case 'jcb':
      return 'JCB';
    case 'unknown':
      return null;
  }
}

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

/**
 * カード番号の判定。ブランド別の桁数(amex:15/他:16)ぶん数字が入っていればよい
 * (デモ用のためLuhnチェックはしない。本人指定 #139)。
 */
export function validateCardNumber(digits: string): boolean {
  return /^\d+$/.test(digits) && digits.length === maxDigitsFor(detectBrand(digits));
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
 * 有効期限の判定。"MM/YY"形式で月が01-12であればよい(デモ用のため過去の年月でも
 * 弾かない。本人指定 #139「月のところだけ01〜12になっていればいい」)。
 */
export function validateExpiry(value: string): boolean {
  const match = /^(\d{2})\/(\d{2})$/.exec(value);
  if (!match) return false;
  const month = Number(match[1]);
  return month >= 1 && month <= 12;
}

/**
 * 登録済みカードの有効期限が切れているかの判定(#147)。
 *
 * **入力時の検証(`validateExpiry`)とは目的が別**なので関数を分けている。あちらは
 * 「デモ用に過去の年月も受け付ける」(#139 本人指定)ままにし、こちらは**登録された後の
 * 状態表示**に使う——入力を弾かない方針と、切れていることを知らせる必要は両立する。
 *
 * "MM/YY" はその月の**末日まで有効**(カード業界の慣行)なので、翌月1日の0時を過ぎた時点で
 * 切れたと判定する。
 *
 * 形式が不正な値は `false`(切れていない扱い)を返す。判定できないものを「切れている」と
 * 断定すると、誤った警告でカードの変更を促してしまうため。
 */
export function isCardExpired(expiry: string, now: Date): boolean {
  const match = /^(\d{2})\/(\d{2})$/.exec(expiry);
  if (!match) return false;

  const month = Number(match[1]);
  if (month < 1 || month > 12) return false;

  // Dateの月は0始まりのため、1-12の`month`をそのまま渡すと「翌月の1日」になる
  const firstDayAfterExpiry = new Date(2000 + Number(match[2]), month, 1);
  return now.getTime() >= firstDayAfterExpiry.getTime();
}

/** セキュリティコードの判定(Amex: 4桁、他ブランド: 3桁の数字) */
export function validateCvc(value: string, brand: CardBrand): boolean {
  return brand === 'amex' ? /^\d{4}$/.test(value) : /^\d{3}$/.test(value);
}
