import { describe, expect, it } from 'vitest';
import { getInitialTheme } from './theme';

describe('getInitialTheme', () => {
  it('保存済みの値があればOSの設定より優先する', () => {
    expect(getInitialTheme(true, 'light')).toBe('light');
    expect(getInitialTheme(false, 'dark')).toBe('dark');
  });

  it('保存済みの値が無ければOSの設定に従う', () => {
    expect(getInitialTheme(true, null)).toBe('dark');
    expect(getInitialTheme(false, null)).toBe('light');
  });

  it('保存済みの値が不正な文字列ならOSの設定に従う', () => {
    expect(getInitialTheme(true, 'blue')).toBe('dark');
  });
});
