import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor設定。
 *
 * - webDir: Vite の出力先（vite.config.ts の既定どおり "dist"）。
 * - server.androidScheme: 既定の "https" のままだと WebView のオリジンが https になり、
 *   LAN内の平文HTTP（http://192.168.x.x）への通信が混在コンテンツとして遮断される。
 *   "http" に固定してオリジンを揃える。
 * - plugins.CapacitorHttp: fetch() をネイティブ側で実行させることで、
 *   WebViewの混在コンテンツ制限と index.html の CSP（connect-src 'self' ...）を回避する。
 *   これにより src/pairing/ 側の既存 fetch 呼び出しを変更せずに LAN 通信できる。
 */
const config: CapacitorConfig = {
  appId: 'com.itindex.app',
  appName: 'IT-Index',
  webDir: 'dist',
  server: {
    androidScheme: 'http',
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
