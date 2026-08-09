import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { App } from './App';

describe('App', () => {
  afterEach(cleanup);

  it('見出しを表示する', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'IT-Index v2' })).toBeTruthy();
  });

  it('sharedのnormalizeがワークスペース越しに解決される', () => {
    render(<App />);
    // 全角→半角・カタカナ→ひらがな・小文字化(v1 §5.1の正規化ルール)
    expect(screen.getByTestId('normalize-probe').textContent).toBe('it用語いんでっくす');
  });
});
