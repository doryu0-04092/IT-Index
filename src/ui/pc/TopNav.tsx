export type TopNavCurrent = 'search' | 'history' | 'index' | null;

export interface TopNavProps {
  current: TopNavCurrent;
  settingsOpen: boolean;
  linkOpen: boolean;
  onGoSearch: () => void;
  onGoHistory: () => void;
  onGoIndex: () => void;
  onOpenSettings: () => void;
  onOpenLink: () => void;
}

/**
 * 検索/履歴/連携/単語一覧/設定への常設トップナビ（プランC）。
 * 詳細画面・用語ひも付きのチャット画面は文脈依存の「← 検索に戻る」リンクで戻る
 * （未確定チャットの書き出し等の副作用を持つため、ここでは置き換えず並行する導線として追加する）。
 * 「連携」は設定と同じく画面遷移とは独立したモーダル（LinkModal）を開くだけなので、
 * settingsOpenと同じくboolean propで別扱いにする。
 */
export default function TopNav({
  current,
  settingsOpen,
  linkOpen,
  onGoSearch,
  onGoHistory,
  onGoIndex,
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
      <button type="button" className={navItemClass(linkOpen)} onClick={onOpenLink}>
        連携
      </button>
      <button type="button" className={navItemClass(current === 'index')} onClick={onGoIndex}>
        単語一覧
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
