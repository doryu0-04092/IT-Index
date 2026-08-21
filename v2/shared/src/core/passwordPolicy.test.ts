import { describe, expect, it } from 'vitest';
import {
  PASSWORD_MIN_LENGTH,
  checkPasswordRules,
  isCommonPassword,
  validatePassword,
} from './passwordPolicy';

describe('checkPasswordRules', () => {
  it('条件ごとの充足状況を返す(画面のチェックリスト用)', () => {
    expect(checkPasswordRules('Abcdefg1')).toEqual({
      length: true,
      lowercase: true,
      uppercase: true,
      digit: true,
    });
  });

  it('満たしていない条件だけがfalseになる', () => {
    // 'abcdef1' は7文字で大文字を含まない
    expect(checkPasswordRules('abcdef1')).toEqual({
      length: false,
      lowercase: true,
      uppercase: false,
      digit: true,
    });
  });

  it('記号だけでは英字・数字の条件を満たさない', () => {
    const rules = checkPasswordRules('!!!!!!!!');
    expect(rules.length).toBe(true);
    expect(rules.lowercase).toBe(false);
    expect(rules.uppercase).toBe(false);
    expect(rules.digit).toBe(false);
  });
});

describe('validatePassword', () => {
  it('条件をすべて満たせば通る', () => {
    expect(validatePassword('Kaisya2026x')).toEqual({ ok: true });
  });

  it(`${PASSWORD_MIN_LENGTH}文字未満は文字種を満たしていても弾く`, () => {
    const result = validatePassword('Abc123x'); // 7文字。大小英字と数字は揃っている
    expect(result.ok).toBe(false);
    expect(result.code).toBe('too_short');
  });

  it('文字数だけを満たしても文字種が欠けていれば弾く', () => {
    expect(validatePassword('abcdefghij').code).toBe('missing_character_types'); // 大文字・数字なし
    expect(validatePassword('ABCDEFGHIJ').code).toBe('missing_character_types'); // 小文字・数字なし
    expect(validatePassword('Abcdefghij').code).toBe('missing_character_types'); // 数字なし
    expect(validatePassword('abcdefgh12').code).toBe('missing_character_types'); // 大文字なし
  });

  it('記号は条件の代わりにならない(数字を含まなければ弾く)', () => {
    expect(validatePassword('Abcdefg!').code).toBe('missing_character_types');
  });

  it('記号を含んでいても、大小英字と数字が揃っていれば通る', () => {
    expect(validatePassword('Abcdefg1!').ok).toBe(true);
  });

  // ブロックリストの本命。文字種の条件では落ちないため、ここでしか止められない
  it('文字種の条件を満たしていても、よく使われるパスワードは弾く', () => {
    for (const password of ['Password1', 'Qwerty123', 'Passw0rd1', 'Welcome123', 'Abc12345']) {
      const result = validatePassword(password);
      expect(result.ok, password).toBe(false);
      expect(result.code, password).toBe('common_password');
    }
  });

  it('判定順は「文字数 → 文字種 → よく使われるか」', () => {
    // 'abc123' はブロックリストにあるが、まず文字数で落ちる。
    // 短いまま「よく使われています」と言われても直し方が分からないため
    expect(validatePassword('abc123').code).toBe('too_short');
    // 'password' は8文字あるので文字数は通り、文字種で落ちる
    expect(validatePassword('password').code).toBe('missing_character_types');
  });

  it('エラーには利用者にそのまま見せられる日本語が付く', () => {
    expect(validatePassword('Abc12').message).toContain(`${PASSWORD_MIN_LENGTH}文字以上`);
    expect(validatePassword('abcdefghij').message).toContain('英大文字');
    expect(validatePassword('Password1').message).toContain('よく使われている');
  });
});

describe('isCommonPassword', () => {
  it('大文字小文字を無視して判定する', () => {
    expect(isCommonPassword('password1')).toBe(true);
    expect(isCommonPassword('Password1')).toBe(true);
    expect(isCommonPassword('PASSWORD1')).toBe(true);
    expect(isCommonPassword('PaSsWoRd1')).toBe(true);
  });

  it('部分一致はしない(完全一致のみ)', () => {
    expect(isCommonPassword('mypassword1')).toBe(false);
    expect(isCommonPassword('password1234567')).toBe(false);
  });

  it('リストに無いものは通す', () => {
    expect(isCommonPassword('Kaisya2026x')).toBe(false);
  });
});
