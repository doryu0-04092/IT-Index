import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor設定(v2)。
 *
 * - appId: `com.itindex.v2`。v1の`com.itindex.app`とは別IDにして端末上で共存させる
 *   (同一IDにするとv1アプリが上書きされ、v1のローカルデータが消える。本人確定)。
 * - webDir: Vite の出力先(vite.config.ts の既定どおり "dist")。
 * - androidScheme: 既定の"https"のまま使う。v1がLANペアリング用に"http"へ固定していたのに対し、
 *   v2はLAN直結ペアリングを廃止しサーバーリレー同期に一本化した(v1固有の制約はv2に無い)ため不要。
 * - plugins.CapacitorHttp: fetch()をネイティブ側で実行させ、WebViewのCORSプリフライト制限を
 *   回避する(v1 capacitor.config.ts:10-12と同じ実績ある方式。v2ではLAN混在コンテンツ対策ではなく、
 *   Capacitor配信オリジン(http://localhost)と公式APIオリジンが別になることへのCORS対策として使う)。
 */
const config: CapacitorConfig = {
  appId: 'com.itindex.v2',
  appName: 'IT-Index',
  webDir: 'dist',
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
