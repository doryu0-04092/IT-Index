/**
 * テーマの手動切替(移植元: ../../../src/ui/theme.ts)。v1はlight/darkの2択で常に明示保存
 * だったが、v2はOS追従(prefers-color-scheme)を既定にしたうえで「ライト/ダーク/OS追従」を
 * 手動で上書きできるようにする(依頼者指定)。'system'を選んだ場合はdocument.documentElement
 * のdata-theme属性を外し、App.cssの@media (prefers-color-scheme: dark)にそのまま委ねる
 * ——v1のdata-theme方式(App.css :root[data-theme='light'/'dark'])をそのまま踏襲し、
 * 'system'のときだけ属性を持たない状態にする。
 */
export type ThemeChoice = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'it-index-v2-theme';

/** 保存済みの選択を読む。無い・壊れている場合は既定の'system'(v1と異なりv2の既定はOS追従) */
export function readStoredThemeChoice(): ThemeChoice {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  return 'system';
}

export function persistThemeChoice(choice: ThemeChoice): void {
  localStorage.setItem(STORAGE_KEY, choice);
}

/**
 * 選択を実際のDOMへ反映する。'system'はdata-theme属性を外すことでApp.cssの
 * @media (prefers-color-scheme: dark)に委ねる(OS設定を切り替えても即時追従する)。
 */
export function applyThemeChoice(choice: ThemeChoice): void {
  if (choice === 'system') {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = choice;
  }
}
