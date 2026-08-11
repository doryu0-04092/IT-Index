import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import MermaidDiagram from './MermaidDiagram';

// jsdomでは実際のmermaidレンダリング(canvas/SVG計算)ができないため、mermaidモジュール自体を
// モックする(依頼書の指定通り)。initialize/renderの呼び出され方と、失敗時のフォールバック
// (コードブロック表示に切り替わる。v1の隔離思想を踏襲)だけを検証する。
const initializeMock = vi.fn();
const renderMock = vi.fn();

vi.mock('mermaid', () => ({
  default: {
    initialize: (...args: unknown[]) => initializeMock(...args),
    render: (...args: unknown[]) => renderMock(...args),
  },
}));

describe('MermaidDiagram', () => {
  afterEach(() => {
    cleanup();
    initializeMock.mockClear();
    renderMock.mockClear();
    delete document.documentElement.dataset.theme;
  });

  it('構文が正しい場合はmermaid.renderの結果(svg)をコンテナに描画する', async () => {
    renderMock.mockResolvedValue({ svg: '<svg data-testid="fake-svg"></svg>' });

    const { container } = render(<MermaidDiagram code="graph TD;A-->B;" />);

    await waitFor(() => expect(renderMock).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('.mermaid-diagram')?.innerHTML).toContain('fake-svg'));
    expect(container.querySelector('.mermaid-fallback')).toBeNull();
  });

  it('構文エラー時はアプリを壊さずコードブロック表示にフォールバックする', async () => {
    renderMock.mockRejectedValue(new Error('parse error'));

    const { container, getByText } = render(<MermaidDiagram code="invalid mermaid code" />);

    await waitFor(() => expect(getByText('invalid mermaid code')).toBeTruthy());
    expect(container.querySelector('.mermaid-fallback')).toBeTruthy();
    expect(container.querySelector('.mermaid-diagram')).toBeNull();
  });

  it('data-theme=darkの時はdarkテーマでinitializeする', async () => {
    document.documentElement.dataset.theme = 'dark';
    renderMock.mockResolvedValue({ svg: '<svg></svg>' });

    render(<MermaidDiagram code="graph TD;A-->B;" />);

    await waitFor(() => expect(initializeMock).toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark' })));
  });

  it('data-theme=lightの時はdefaultテーマでinitializeする', async () => {
    document.documentElement.dataset.theme = 'light';
    renderMock.mockResolvedValue({ svg: '<svg></svg>' });

    render(<MermaidDiagram code="graph TD;A-->B;" />);

    await waitFor(() => expect(initializeMock).toHaveBeenCalledWith(expect.objectContaining({ theme: 'default' })));
  });

  it('data-theme属性が無い(OS追従)時はprefers-color-schemeで判定する', async () => {
    const matchMediaMock = vi.fn().mockReturnValue({ matches: true });
    vi.stubGlobal('matchMedia', matchMediaMock);
    renderMock.mockResolvedValue({ svg: '<svg></svg>' });

    render(<MermaidDiagram code="graph TD;A-->B;" />);

    await waitFor(() => expect(initializeMock).toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark' })));
    expect(matchMediaMock).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
    vi.unstubAllGlobals();
  });
});
