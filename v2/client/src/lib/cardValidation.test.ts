import { describe, expect, it } from 'vitest';
import {
  detectBrand,
  formatCardNumber,
  formatExpiry,
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

describe('validateCardNumber', () => {
  it('桁数(amex:15/他:16)ぶん数字が入っていれば有効(デモ用にLuhnはしない。#139)', () => {
    expect(validateCardNumber('4242424242424242')).toBe(true);
    expect(validateCardNumber('1111111111111111')).toBe(true); // 適当な16桁もOK
    expect(validateCardNumber('378282246310005')).toBe(true); // amexは15桁
    expect(validateCardNumber('424242424242424')).toBe(false); // 15桁のVisaは桁不足
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

  it('MM/YY形式で月01-12なら有効(デモ用に過去の年月も弾かない。#139)', () => {
    expect(validateExpiry('08/26')).toBe(true);
    expect(validateExpiry('01/00')).toBe(true); // 過去でもOK
    expect(validateExpiry('12/99')).toBe(true);
    expect(validateExpiry('13/27')).toBe(false);
    expect(validateExpiry('00/27')).toBe(false);
    expect(validateExpiry('1225')).toBe(false); // 形式不一致
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
