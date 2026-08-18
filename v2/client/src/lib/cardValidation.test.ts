import { describe, expect, it } from 'vitest';
import {
  detectBrand,
  formatCardNumber,
  formatExpiry,
  luhnCheck,
  normalizeCardNumber,
  validateCardNumber,
  validateCvc,
  validateExpiry,
} from './cardValidation';

describe('detectBrand', () => {
  it('先頭桁で各ブランドを判定する', () => {
    expect(detectBrand('4111111111111111')).toBe('visa');
    expect(detectBrand('5555555555554444')).toBe('mastercard');
    expect(detectBrand('2221000000000009')).toBe('mastercard');
    expect(detectBrand('378282246310005')).toBe('amex');
    expect(detectBrand('3530111333300000')).toBe('jcb');
    expect(detectBrand('9999999999999999')).toBe('unknown');
  });

  it('2シリーズMastercardは4桁未満ではunknown(判定素材不足)', () => {
    expect(detectBrand('222')).toBe('unknown');
    expect(detectBrand('2221')).toBe('mastercard');
    expect(detectBrand('2721')).toBe('unknown');
  });
});

describe('normalizeCardNumber / formatCardNumber', () => {
  it('数字以外を除去し16桁(amexは15桁)へ丸める', () => {
    expect(normalizeCardNumber('4242 4242 4242 4242 99')).toBe('4242424242424242');
    expect(normalizeCardNumber('3782 822463 10005 99')).toBe('378282246310005');
    expect(normalizeCardNumber('abc')).toBe('');
  });

  it('Visa等は4-4-4-4、Amexは4-6-5で整形する', () => {
    expect(formatCardNumber('4242424242424242')).toBe('4242 4242 4242 4242');
    expect(formatCardNumber('378282246310005')).toBe('3782 822463 10005');
  });

  it('入力途中の桁数でも末尾区切りなしで整形する', () => {
    expect(formatCardNumber('')).toBe('');
    expect(formatCardNumber('42')).toBe('42');
    expect(formatCardNumber('42424')).toBe('4242 4');
    expect(formatCardNumber('37828')).toBe('3782 8');
  });
});

describe('luhnCheck / validateCardNumber', () => {
  it('正しいチェックディジットを受理し、1桁違いを弾く', () => {
    expect(luhnCheck('4242424242424242')).toBe(true);
    expect(luhnCheck('4242424242424243')).toBe(false);
  });

  it('桁数が揃いLuhnが通るときだけカード番号を有効とする', () => {
    expect(validateCardNumber('4242424242424242')).toBe(true);
    expect(validateCardNumber('378282246310005')).toBe(true);
    expect(validateCardNumber('424242424242424')).toBe(false); // 15桁のVisaは桁不足
    expect(validateCardNumber('4242424242424241')).toBe(false); // Luhn不成立
    expect(validateCardNumber('')).toBe(false);
  });
});

describe('formatExpiry / validateExpiry', () => {
  it('3桁目以降が入った時点でMM/YYに整形する', () => {
    expect(formatExpiry('1')).toBe('1');
    expect(formatExpiry('12')).toBe('12');
    expect(formatExpiry('122')).toBe('12/2');
    expect(formatExpiry('1225')).toBe('12/25');
    expect(formatExpiry('12/25')).toBe('12/25');
    expect(formatExpiry('122534')).toBe('12/25');
  });

  it('月の範囲と当月以降(記載月の末日まで有効)を判定する', () => {
    const now = new Date(2026, 7, 18); // 2026-08-18
    expect(validateExpiry('08/26', now)).toBe(true); // 当月はまだ有効
    expect(validateExpiry('07/26', now)).toBe(false); // 先月は失効
    expect(validateExpiry('12/99', now)).toBe(true);
    expect(validateExpiry('13/27', now)).toBe(false);
    expect(validateExpiry('00/27', now)).toBe(false);
    expect(validateExpiry('1225', now)).toBe(false); // 形式不一致
  });
});

describe('validateCvc', () => {
  it('Amexは4桁、他ブランドは3桁の数字だけを受理する', () => {
    expect(validateCvc('123', 'visa')).toBe(true);
    expect(validateCvc('1234', 'visa')).toBe(false);
    expect(validateCvc('1234', 'amex')).toBe(true);
    expect(validateCvc('123', 'amex')).toBe(false);
    expect(validateCvc('12a', 'jcb')).toBe(false);
    expect(validateCvc('123', 'unknown')).toBe(true);
  });
});
