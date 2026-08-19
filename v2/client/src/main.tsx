import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

import { detectIsNativeApp } from './lib/platform';

/**
 * ネイティブ(Capacitor Androidアプリ)実行時にdocument.documentElementへ`native-app`クラスを付与する
 * (ネイティブ限定調整用フック。PR-S§3)。判定の実体はlib/platform.tsに移した(#157で
 * ReactからもuseAppInit経由で同じ判定を使うため)。
 */
void detectIsNativeApp().then((isNative) => {
  if (isNative) {
    document.documentElement.classList.add('native-app');
  }
});

const root = document.getElementById('root');
if (!root) {
  throw new Error('#root が index.html に存在しない');
}

/**
 * dev限定の単体プレビュー(?preview=checkout)。チェックアウト画面のUIだけをアプリ本体・
 * ログインなしで確認する(dev/CheckoutPreview.tsx参照)。import.meta.env.DEVは本番ビルドで
 * falseに静的置換されるため、この分岐とプレビューのチャンクは本番バンドルに含まれない。
 */
const previewTarget = import.meta.env.DEV
  ? new URLSearchParams(window.location.search).get('preview')
  : null;

if (previewTarget === 'checkout') {
  void import('./dev/CheckoutPreview').then(({ default: CheckoutPreview }) => {
    createRoot(root).render(
      <StrictMode>
        <CheckoutPreview />
      </StrictMode>
    );
  });
} else {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
