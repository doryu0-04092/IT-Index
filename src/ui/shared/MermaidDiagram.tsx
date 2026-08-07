import { useEffect, useRef, useState } from 'react';

let idCounter = 0;

export interface MermaidDiagramProps {
  code: string;
}

/**
 * Mermaid記法の図を実際に描画する。AIが生成したコードが常に構文的に正しいとは
 * 限らないため、構文エラー時は元のテキストをそのまま表示する（PC版・Android版共通）。
 * バンドルサイズを抑えるため、mermaidは実際に図を表示する時だけ動的import する。
 */
export default function MermaidDiagram({ code }: MermaidDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(false);

    (async () => {
      const { default: mermaid } = await import('mermaid');
      const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default';
      mermaid.initialize({ startOnLoad: false, theme, securityLevel: 'strict' });
      const id = `mermaid-${++idCounter}`;
      try {
        const { svg } = await mermaid.render(id, code);
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg;
        }
      } catch {
        if (!cancelled) setError(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error) {
    return <pre className="mermaid-fallback">{code}</pre>;
  }

  return <div className="mermaid-diagram" ref={containerRef} />;
}
