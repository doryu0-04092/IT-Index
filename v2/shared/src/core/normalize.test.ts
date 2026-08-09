import { describe, expect, it } from 'vitest';
import { normalize } from './normalize';

describe('normalize', () => {
  it('unifies katakana and hiragana', () => {
    expect(normalize('サーバ')).toBe(normalize('さーば'));
  });

  it('unifies full-width and half-width alnum', () => {
    expect(normalize('ＴＣＰ')).toBe(normalize('TCP'));
  });

  it('ignores ascii case', () => {
    expect(normalize('tcp')).toBe(normalize('TCP'));
  });

  it('does not touch kanji', () => {
    expect(normalize('冗長化')).toBe('冗長化');
  });
});
