import { useEffect, useRef, useState } from 'react';

let idCounter = 0;

export interface MermaidDiagramProps {
  code: string;
}

/**
 * 現在の実際のライト/ダーク表示を判定する。v1はdata-theme属性がlight/darkの2択で
 * 常に明示されていたためdata-theme一本で判定できたが、v2はテーマ選択に'system'
 * (OS追従)があり、その場合はdata-theme属性自体を持たない(lib/theme.ts)。
 * data-themeが無い時にmermaidの既定テーマ(常にlight相当)へ固定してしまうと、
 * OSがダークモードの利用者だけ図が浮いて見えるため、その場合だけ
 * prefers-color-schemeを見る(v1からの変更点。v2のテーマ設計に合わせた追加)。
 */
function currentIsDark(): boolean {
  const dataTheme = document.documentElement.dataset.theme;
  if (dataTheme === 'dark') return true;
  if (dataTheme === 'light') return false;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

/**
 * Mermaid記法の図を実際に描画する。AIが生成したコードが常に構文的に正しいとは
 * 限らないため、構文エラー時は元のテキストをそのまま表示する。
 * バンドルサイズを抑えるため、mermaidは実際に図を表示する時だけ動的import する。
 * 移植元: ../../../../src/ui/shared/MermaidDiagram.tsx(v1)。テーマ判定のみ上記の理由で拡張。
 */
export default function MermaidDiagram({ code }: MermaidDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setError(false);
      const { default: mermaid } = await import('mermaid');
      const theme = currentIsDark() ? 'dark' : 'default';
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
