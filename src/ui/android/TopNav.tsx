export type TopNavCurrent = 'search' | 'history' | 'chat-free' | null;

export interface TopNavProps {
  current: TopNavCurrent;
  settingsOpen: boolean;
  linkOpen: boolean;
  onGoSearch: () => void;
  onGoHistory: () => void;
  onGoFreeChat: () => void;
  onOpenSettings: () => void;
  onOpenLink: () => void;
}

/**
 * 検索/履歴/自由な質問/連携/設定への常設トップナビ（Android版）。
 * PC版と同じ構造・同じCSSクラス名を使う（見た目を大きく変えないため）。
 * 狭幅での折り返し・タップ領域確保は `.android-app .top-nav` 側のCSSで対応する
 * （`src/index.css` 末尾。マークアップ自体はPC版と同一）。
 */
export default function TopNav({
  current,
  settingsOpen,
  linkOpen,
  onGoSearch,
  onGoHistory,
  onGoFreeChat,
  onOpenSettings,
  onOpenLink,
}: TopNavProps) {
  return (
    <nav className="top-nav">
      <button type="button" className={navItemClass(current === 'search')} onClick={onGoSearch}>
        検索
      </button>
      <button type="button" className={navItemClass(current === 'history')} onClick={onGoHistory}>
        履歴
      </button>
      <button type="button" className={navItemClass(current === 'chat-free')} onClick={onGoFreeChat}>
        自由に質問
      </button>
      <button type="button" className={navItemClass(linkOpen)} onClick={onOpenLink}>
        連携
      </button>
      <button type="button" className={navItemClass(settingsOpen)} onClick={onOpenSettings}>
        設定
      </button>
    </nav>
  );
}

function navItemClass(active: boolean): string {
  return active ? 'top-nav-item active' : 'top-nav-item';
}
