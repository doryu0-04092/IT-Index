export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'it-index-theme';

/** 保存済みの明示的な選択があればそれを使う。無ければOSの設定に従う */
export function getInitialTheme(prefersDark: boolean, stored: string | null): Theme {
  if (stored === 'light' || stored === 'dark') return stored;
  return prefersDark ? 'dark' : 'light';
}

export function readStoredTheme(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}

export function persistTheme(theme: Theme): void {
  localStorage.setItem(STORAGE_KEY, theme);
}
