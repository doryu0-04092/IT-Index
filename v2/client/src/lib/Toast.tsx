import { useEffect } from 'react';

export interface ToastProps {
  message: string;
  onDismiss: () => void;
  /** 自動で消えるまでの時間(ms)。省略時は6000ms(v1 ../../../src/ui/pc/Toast.tsx準拠) */
  durationMs?: number;
  /** 'error'(既定)はエラー表示。'info'は確定処理中等の進行状況表示に使う */
  variant?: 'error' | 'info';
}

/**
 * 常時表示のバナーと違い、一定時間で自動的に消える一時的な通知
 * (移植元: ../../../src/ui/pc/Toast.tsx。ロジック・マークアップともにv1準拠)。
 */
export default function Toast({ message, onDismiss, durationMs = 6000, variant = 'error' }: ToastProps) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(timer);
  }, [message, durationMs, onDismiss]);

  return (
    <div className={`toast toast-${variant}`} role={variant === 'error' ? 'alert' : 'status'}>
      <p>{message}</p>
      <button type="button" className="btn-text" onClick={onDismiss} aria-label="閉じる">
        ✕
      </button>
    </div>
  );
}
