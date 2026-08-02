import { Capacitor } from '@capacitor/core';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { androidUi } from './ui/android';
import { pcUi } from './ui/pc';
import './index.css';

// PC版（ブラウザ・Electron）とAndroid版は独立した画面コンポーネント一式として作られている
// （docs/ui-pc.md:8）。差し替えるのは画面だけで、統括ロジック（App.tsx）は共通のまま。
// isNativePlatform() は Capacitorランタイム（Android実機・エミュレータ）でのみ true を
// 返すため、ブラウザ・Electronでは従来どおりPC版が出る。
const ui = Capacitor.isNativePlatform() ? androidUi : pcUi;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App ui={ui} />
  </StrictMode>,
);
