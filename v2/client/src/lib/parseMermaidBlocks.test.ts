import { describe, expect, it } from 'vitest';
import { parseMermaidBlocks } from './parseMermaidBlocks';

// 移植元: ../../../../src/ui/shared/parseMermaidBlocks.test.ts(v1と同一のケース)。
describe('parseMermaidBlocks', () => {
  it('returns a single text part when there is no mermaid fence', () => {
    expect(parseMermaidBlocks('ただの説明文です。')).toEqual([{ type: 'text', value: 'ただの説明文です。' }]);
  });

  it('extracts a single mermaid block with no surrounding text', () => {
    const content = '```mermaid\ngraph TD;\nA-->B;\n```';
    expect(parseMermaidBlocks(content)).toEqual([{ type: 'mermaid', code: 'graph TD;\nA-->B;' }]);
  });

  it('extracts a mermaid block surrounded by text', () => {
    const content = '説明はこちらです。\n```mermaid\ngraph TD;\nA-->B;\n```\n以上が図の説明です。';
    expect(parseMermaidBlocks(content)).toEqual([
      { type: 'text', value: '説明はこちらです。\n' },
      { type: 'mermaid', code: 'graph TD;\nA-->B;' },
      { type: 'text', value: '\n以上が図の説明です。' },
    ]);
  });

  it('extracts multiple mermaid blocks', () => {
    const content = '1つ目:\n```mermaid\nA\n```\n2つ目:\n```mermaid\nB\n```';
    expect(parseMermaidBlocks(content)).toEqual([
      { type: 'text', value: '1つ目:\n' },
      { type: 'mermaid', code: 'A' },
      { type: 'text', value: '\n2つ目:\n' },
      { type: 'mermaid', code: 'B' },
    ]);
  });

  it('handles CRLF line endings', () => {
    const content = '```mermaid\r\ngraph TD;\r\nA-->B;\r\n```';
    expect(parseMermaidBlocks(content)).toEqual([{ type: 'mermaid', code: 'graph TD;\r\nA-->B;' }]);
  });
});
