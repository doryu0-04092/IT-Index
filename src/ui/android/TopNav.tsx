import { useEffect, useRef, useState } from 'react';

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

interface DrawerEntry {
  key: string;
  label: string;
  icon: string;
  active: boolean;
  run: () => void;
}

/**
 * Android版のナビゲーション。左上のボタンから、左端に縦のドロワーをスライドさせる。
 *
 * PC版は5項目を画面最上部に横並びにしているが、縦持ちのスマホでは
 * **画面上部は片手だと親指が届かず**、5項目を横に並べると1項目あたりの幅も足りない。
 * ドロワーなら項目を縦に積めるので、ラベルを省略せず、1項目あたり十分な高さを取れる。
 *
 * propsはPC版と同一に保つ（src/ui/uiSet.ts が型で強制している）。
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
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);

  // 開いている間だけ、戻る操作（Android の戻るジェスチャー／Escape）でドロワーを閉じる。
  // 画面遷移より先にドロワーが閉じるのが利用者の期待に沿う。
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  // 開いた直後に最初の項目へフォーカスを移す（キーボード／スクリーンリーダー利用時に
  // ドロワーの外に取り残されないようにする）。
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLButtonElement>('.drawer-item')?.focus();
  }, [open]);

  const entries: DrawerEntry[] = [
    { key: 'search', label: '検索', icon: '🔍', active: current === 'search', run: onGoSearch },
    { key: 'history', label: '履歴', icon: '🕒', active: current === 'history', run: onGoHistory },
    { key: 'chat', label: '自由に質問', icon: '💬', active: current === 'chat-free', run: onGoFreeChat },
    { key: 'link', label: '連携', icon: '🔗', active: linkOpen, run: onOpenLink },
    { key: 'settings', label: '設定', icon: '⚙️', active: settingsOpen, run: onOpenSettings },
  ];

  function select(entry: DrawerEntry) {
    setOpen(false);
    // 閉じるアニメーションと画面の切り替えが重ならないよう、閉じてから実行する
    entry.run();
  }

  function close() {
    setOpen(false);
    toggleRef.current?.focus();
  }

  const activeLabel = entries.find((e) => e.active)?.label ?? '検索';

  return (
    <>
      <div className="drawer-bar">
        <button
          ref={toggleRef}
          type="button"
          className="drawer-toggle"
          aria-expanded={open}
          aria-label="メニューを開く"
          onClick={() => setOpen(true)}
        >
          ☰
        </button>
        <span className="drawer-current">{activeLabel}</span>
      </div>

      {open && (
        <div className="drawer-root">
          {/* 背景を押して閉じる。div ではなく button にすることで、キーボードや
              スクリーンリーダーからも同じ操作ができる。 */}
          <button type="button" className="drawer-scrim" aria-label="メニューを閉じる" onClick={close} />
          <div className="drawer-panel" ref={panelRef} role="dialog" aria-modal="true" aria-label="メニュー">
            <div className="drawer-panel-head">
              <span>メニュー</span>
              <button type="button" className="drawer-close" aria-label="メニューを閉じる" onClick={close}>
                ✕
              </button>
            </div>
            <nav className="drawer-list">
              {entries.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  className={entry.active ? 'drawer-item active' : 'drawer-item'}
                  aria-current={entry.active ? 'page' : undefined}
                  onClick={() => select(entry)}
                >
                  <span className="drawer-item-icon" aria-hidden="true">
                    {entry.icon}
                  </span>
                  {entry.label}
                </button>
              ))}
            </nav>
          </div>
        </div>
      )}
    </>
  );
}
