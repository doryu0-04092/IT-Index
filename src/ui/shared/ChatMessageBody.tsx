import MermaidDiagram from './MermaidDiagram';
import { parseMermaidBlocks } from './parseMermaidBlocks';

export interface ChatMessageBodyProps {
  content: string;
}

/**
 * AIチャットのassistant発言本文を表示する（PC版・Android版共通）。単語詳細のノート表示と
 * 同じ`MermaidDiagram`で```mermaidフェンスを図として描画し、それ以外は通常のテキストとして表示する。
 * userの発言（自由形式のMermaid記法が混ざらない）は呼び出し側で従来通り`<p>`のまま表示してよい。
 */
export default function ChatMessageBody({ content }: ChatMessageBodyProps) {
  const parts = parseMermaidBlocks(content);
  return (
    <>
      {parts.map((part, i) => (part.type === 'mermaid' ? <MermaidDiagram key={i} code={part.code} /> : <p key={i}>{part.value}</p>))}
    </>
  );
}
