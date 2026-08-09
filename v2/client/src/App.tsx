import { normalize } from '@it-index/shared';

/**
 * Phase 0の仮画面。実装はPhase 1で載せる(docs/v2/architecture.md §8)。
 * sharedからのimportは、ワークスペース間の解決(tsc/vitest/vite build)が
 * 通っていることをCIで確認するための配線でもある。
 */
export function App() {
  return (
    <main>
      <h1>IT-Index v2</h1>
      <p>Phase 0 — CI整備中。検索・辞書機能は Phase 1 で移植する。</p>
      <p data-testid="normalize-probe">{normalize('ＩＴ用語インデックス')}</p>
    </main>
  );
}
