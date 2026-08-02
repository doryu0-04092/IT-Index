import { describe, expect, it } from 'vitest';
import { isUnsupportedBrowser } from './browserSupport';

const UA = {
  iosSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  ipadSafari:
    'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  iosChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/119.0.6045.109 Mobile/15E148 Safari/604.1',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  windowsChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  windowsEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Edg/119.0.0.0',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36',
  windowsFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
};

describe('isUnsupportedBrowser', () => {
  it('iOS Safari は非対応', () => {
    expect(isUnsupportedBrowser(UA.iosSafari)).toBe(true);
  });

  it('iPadOS Safari は非対応', () => {
    expect(isUnsupportedBrowser(UA.ipadSafari)).toBe(true);
  });

  it('iOS Chrome（実態はSafari WebView）も非対応（iOSである時点でOS制約を受けるため）', () => {
    expect(isUnsupportedBrowser(UA.iosChrome)).toBe(true);
  });

  it('macOS Safari は非対応', () => {
    expect(isUnsupportedBrowser(UA.macSafari)).toBe(true);
  });

  it('macOS Chrome は対応（PC Chromeとして許可）', () => {
    expect(isUnsupportedBrowser(UA.macChrome)).toBe(false);
  });

  it('Windows Chrome は対応', () => {
    expect(isUnsupportedBrowser(UA.windowsChrome)).toBe(false);
  });

  it('Windows Edge は対応', () => {
    expect(isUnsupportedBrowser(UA.windowsEdge)).toBe(false);
  });

  it('Android Chrome は対応', () => {
    expect(isUnsupportedBrowser(UA.androidChrome)).toBe(false);
  });

  it('Windows Firefox は「非対応」ではない（鍵の保存機能のみ制限、要件定義書§3）', () => {
    expect(isUnsupportedBrowser(UA.windowsFirefox)).toBe(false);
  });
});
