import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import Toast from './Toast';

describe('Toast', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('メッセージを表示し、閉じるボタンでonDismissが呼ばれる', () => {
    const onDismiss = vi.fn();
    render(<Toast message="失敗しました" onDismiss={onDismiss} />);

    expect(screen.getByText('失敗しました')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('閉じる'));
    expect(onDismiss).toHaveBeenCalled();
  });

  it('指定時間が経つと自動でonDismissが呼ばれる(自動消滅)', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Toast message="取り込みました。" variant="info" durationMs={1000} onDismiss={onDismiss} />);

    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(999);
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDismiss).toHaveBeenCalled();
  });
});
