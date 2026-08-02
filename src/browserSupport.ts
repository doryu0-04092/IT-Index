/**
 * 対応環境の判定（要件定義書§3）。
 * 対応: Android(Chrome) / PC(Chrome・Edge)
 * 非対応: iPhone・iPad・macOS Safari
 * 制限あり: Firefox（鍵の保存機能のみ制限。今回は非対応バナーとは別に扱わず対象外）
 */
export function isUnsupportedBrowser(userAgent: string): boolean {
  const isIOS = /iPhone|iPad|iPod/.test(userAgent);
  const isMac = /Macintosh/.test(userAgent);
  const isSafari = /Safari/.test(userAgent) && !/Chrome|Chromium|Edg|CriOS|FxiOS/.test(userAgent);
  return isIOS || (isMac && isSafari);
}
