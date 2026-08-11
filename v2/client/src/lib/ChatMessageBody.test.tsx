import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import ChatMessageBody from './ChatMessageBody';

// ChatMessageBodyがMermaidDiagramを実際に使っていることだけを確認したいので、
// MermaidDiagram自体はモックしてmermaidの実描画(jsdomでは不可)を避ける。
vi.mock('./MermaidDiagram', () => ({
  default: ({ code }: { code: string }) => <div data-testid="mermaid-stub">{code}</div>,
}));

describe('ChatMessageBody', () => {
  afterEach(cleanup);

  it('mermaidフェンスが無い場合は通常のテキストとして表示する', () => {
    const { getByText, queryByTestId } = render(<ChatMessageBody content="ただの説明文です。" />);
    expect(getByText('ただの説明文です。')).toBeTruthy();
    expect(queryByTestId('mermaid-stub')).toBeNull();
  });

  it('```mermaidブロックはMermaidDiagramに渡され、前後のテキストは通常表示される', () => {
    const content = '説明はこちらです。\n```mermaid\ngraph TD;\nA-->B;\n```\n以上が図の説明です。';
    const { getByText, getByTestId } = render(<ChatMessageBody content={content} />);

    expect(getByText(/説明はこちらです。/)).toBeTruthy();
    expect(getByText(/以上が図の説明です。/)).toBeTruthy();
    expect(getByTestId('mermaid-stub').textContent).toBe('graph TD;\nA-->B;');
  });
});
