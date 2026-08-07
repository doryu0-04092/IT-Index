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

/**
 * 接続先はプライベートアドレスに限定する。
 *
 * ここを緩めると、攻撃者が用意したQR（任意のURL＋攻撃者自身の鍵）を読ませるだけで、
 * 利用者の全スナップショットを外部サーバーへ送信させられる。鍵も攻撃者のものなので
 * AES-GCMによる暗号化は一切の防御にならない。**この関数が唯一の防波堤になっている。**
 */
function isPrivateHost(hostname: string): boolean {
  // IPv6ループバック。角括弧はURLパース時に取り除かれている
  if (hostname === '::1') return true;

  const octets = hostname.split('.');
  if (octets.length !== 4) return false;

  const nums = octets.map((o) => (/^\d{1,3}$/.test(o) ? Number(o) : Number.NaN));
  if (nums.some((n) => Number.isNaN(n) || n > 255)) return false;

  const [a, b] = nums;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8（ループバック。同一端末での検証用）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16（リンクローカル）
  return false;
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
  // ホスト名（DNS名）は許可しない。名前解決の先が外部である可能性を排除できないため
  if (!isPrivateHost(parsed.hostname)) return false;
  return true;
}
