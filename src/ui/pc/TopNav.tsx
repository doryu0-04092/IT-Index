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
 * 検索/履歴/自由な質問/連携/設定への常設トップナビ（プランC）。
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
