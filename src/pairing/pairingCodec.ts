/**
 * QRに載せる「相手URL + 使い捨て鍵」のペイロード。docs/manual-sync.md のLAN直結ペアリング機能。
 * QRは他アプリのものを誤って読み取る可能性があるため、decode側は例外を投げず null を返す。
 */
export interface PairingPayload {
  v: 1;
  url: string; // 例 "http://192.168.1.10:17321"
  k: string; // 32バイトの鍵の base64url
}

export function encodePairingPayload(p: PairingPayload): string {
  return JSON.stringify(p);
}

/** 壊れた入力・想定外のバージョンでは例外を投げず null を返す */
export function decodePairingPayload(text: string): PairingPayload | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Record<string, unknown>;

  if (candidate.v !== 1) return null;
  if (typeof candidate.url !== 'string' || !isValidPairingUrl(candidate.url)) return null;
  if (typeof candidate.k !== 'string' || candidate.k.length === 0) return null;

  return { v: 1, url: candidate.url, k: candidate.k };
}

function isValidPairingUrl(url: string): boolean {
  if (!url.startsWith('http://')) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:') return false;
  if (!parsed.hostname) return false;
  if (!parsed.port) return false;
  return true;
}
