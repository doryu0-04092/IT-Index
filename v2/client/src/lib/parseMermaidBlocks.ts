export type MessagePart = { type: 'text'; value: string } | { type: 'mermaid'; code: string };

/** ```mermaid ... ``` フェンスを検出する。改行の有無・CRLFどちらでも通るように緩めに書く */
const MERMAID_FENCE = /```mermaid[ \t]*\r?\n([\s\S]*?)```/g;

/**
 * AIチャットの返答本文から ```mermaid フェンスを検出し、テキスト断片とMermaidコード断片に
 * 分割する。単語詳細のノート(`diagrams`フィールド)とは違い、チャットの返答はAIが本文中に
 * 自発的にMermaid記法を書いてくる自由形式のため、後からテキストを解析して取り出す必要がある。
 * 空文字列の断片(フェンスの直前直後に何も無い場合)は作らない。
 * 移植元: ../../../../src/ui/shared/parseMermaidBlocks.ts(v1と同一。変更なし)。
 */
export function parseMermaidBlocks(content: string): MessagePart[] {
  const parts: MessagePart[] = [];
  let lastIndex = 0;

  for (const match of content.matchAll(MERMAID_FENCE)) {
    const index = match.index ?? 0;
    const [full, code] = match;

    if (index > lastIndex) {
      const text = content.slice(lastIndex, index);
      if (text.trim() !== '') parts.push({ type: 'text', value: text });
    }
    parts.push({ type: 'mermaid', code: code.trim() });
    lastIndex = index + full.length;
  }

  if (lastIndex < content.length) {
    const text = content.slice(lastIndex);
    if (text.trim() !== '') parts.push({ type: 'text', value: text });
  }

  if (parts.length === 0) parts.push({ type: 'text', value: content });
  return parts;
}
