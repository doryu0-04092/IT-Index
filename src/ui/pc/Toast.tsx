import { useEffect } from 'react';

export interface ToastProps {
  message: string;
  onDismiss: () => void;
  /** 自動で消えるまでの時間(ms)。省略時は6000ms */
  durationMs?: number;
}

/** 常時表示のバナーと違い、一定時間で自動的に消える一時的な通知（グローバルエラー表示に使う） */
export default function Toast({ message, onDismiss, durationMs = 6000 }: ToastProps) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(timer);
  }, [message, durationMs, onDismiss]);

  return (
    <div className="toast toast-error" role="alert">
      <p>{message}</p>
      <button type="button" className="btn-text" onClick={onDismiss} aria-label="閉じる">
        ✕
      </button>
    </div>
  );
}
