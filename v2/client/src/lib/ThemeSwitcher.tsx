import type { ThemeChoice } from './theme';

export interface ThemeSwitcherProps {
  choice: ThemeChoice;
  onChange: (choice: ThemeChoice) => void;
}

const OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: 'system', label: 'OS追従' },
  { value: 'light', label: 'ライト' },
  { value: 'dark', label: 'ダーク' },
];

/**
 * テーマ手動切替UI(依頼者指定: 移植元v1(../../../src/App.tsx:636-645)はライト/ダークの
 * 2択トグルボタンだったが、v2はOS追従を既定にしたうえで手動上書きできる3択にする)。
 * 置き場所は暫定で同期画面末尾(SyncScreen.tsx)——PR-Hで設定タブへ移設予定。
 */
export default function ThemeSwitcher({ choice, onChange }: ThemeSwitcherProps) {
  return (
    <div className="theme-switcher">
      <span className="theme-switcher-label">テーマ</span>
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={choice === opt.value ? 'theme-switcher-btn theme-switcher-btn-active' : 'theme-switcher-btn'}
          aria-pressed={choice === opt.value}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
