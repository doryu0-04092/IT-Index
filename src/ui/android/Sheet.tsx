import { useEffect, useRef, type ReactNode } from 'react';

export interface SheetProps {
  title: string;
  onClose: () => void;
  /** 背景を押しても閉じない（初回案内のように、読んでから閉じてほしいもの） */
  dismissOnScrim?: boolean;
  children: ReactNode;
}

/**
 * Android版のモーダル。画面下端から立ち上がるシート。
 *
 * PC版は画面中央に浮くダイアログ（`.modal-overlay` / `.modal-content`）だが、
 * 縦持ちのスマホでは**中央のダイアログは閉じる操作も内容も親指から遠い**。
 * 下から出せば、操作の起点も内容も手の届く範囲に集まる。
 *
 * PC版に共通の<Modal>が無く各所でマークアップを手書きしている事情は変えられないが、
 * Android版は新規なので**ここで1つに寄せる**（4画面が同じ挙動になる）。
 */
export default function Sheet({ title, onClose, dismissOnScrim = true, children }: SheetProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // 開いている間は背後の画面をスクロールさせない。シート内を最後までスクロールした
  // まま指を動かし続けると背後が動いてしまうのを防ぐ。
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return (
    <div className="sheet-root">
      {/* 背景。div ではなく button にすることで、キーボードやスクリーンリーダーからも
          同じ操作ができる（PC版が div + onClick で握っている部分の作り直し）。 */}
      <button
        type="button"
        className="sheet-scrim"
        aria-label={dismissOnScrim ? '閉じる' : undefined}
        aria-hidden={dismissOnScrim ? undefined : true}
        tabIndex={dismissOnScrim ? undefined : -1}
        onClick={dismissOnScrim ? onClose : undefined}
      />
      <div className="sheet-panel" ref={panelRef} role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-grabber" aria-hidden="true" />
        <div className="sheet-head">
          <h2>{title}</h2>
          <button type="button" className="sheet-close" aria-label="閉じる" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}
