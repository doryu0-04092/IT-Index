import { afterEach, describe, expect, it } from 'vitest';
import { applyThemeChoice, persistThemeChoice, readStoredThemeChoice } from './theme';

describe('theme', () => {
  afterEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it('保存が無い場合は既定でOS追従(system)を返す', () => {
    expect(readStoredThemeChoice()).toBe('system');
  });

  it('保存すると同じ値を読み戻せる(保存・復元)', () => {
    persistThemeChoice('dark');
    expect(readStoredThemeChoice()).toBe('dark');

    persistThemeChoice('light');
    expect(readStoredThemeChoice()).toBe('light');
  });

  it('壊れた値が保存されている場合はsystemにフォールバックする', () => {
    localStorage.setItem('it-index-v2-theme', 'not-a-theme');
    expect(readStoredThemeChoice()).toBe('system');
  });

  it('light/darkはdata-theme属性を設定し、systemは属性を外してOS追従に委ねる', () => {
    applyThemeChoice('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');

    applyThemeChoice('light');
    expect(document.documentElement.dataset.theme).toBe('light');

    applyThemeChoice('system');
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});
