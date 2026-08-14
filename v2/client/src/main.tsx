import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

/**
 * ネイティブ(Capacitor Androidアプリ)実行時にdocument.documentElementへ`native-app`クラスを付与する
 * (将来のネイティブ限定調整用フック。PR-S§3)。
 *
 * 動的import + try/catchにする理由: `@capacitor/core`は通常依存として入っているためWebビルドでも
 * バンドルされビルド自体は壊れないが、静的importにすると「Capacitor未導入のWebビルドでも動くよう
 * 失敗許容にする」という設計意図(承認済みプラン PR-S§3)が将来の変更で崩れても検知しづらい。
 * ここで明示的にtry/catchすることで、Capacitor環境が無い状況(将来clientをCapacitor無しで
 * 単体配布する等)でも起動が失敗しないことを保証する。
 */
void (async () => {
  try {
    const { Capacitor } = await import('@capacitor/core');
    if (Capacitor.isNativePlatform()) {
      document.documentElement.classList.add('native-app');
    }
  } catch {
    // Capacitorが無い/読み込めない環境では何もしない(Webとしてそのまま動く)。
  }
})();

const root = document.getElementById('root');
if (!root) {
  throw new Error('#root が index.html に存在しない');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
