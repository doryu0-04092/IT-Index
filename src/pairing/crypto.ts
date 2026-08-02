/**
 * LAN直結ペアリング用の暗号化。src/keystore/crypto.ts と同じ方式（AES-256-GCM, Web Crypto API のみ）。
 * 違いは鍵がPRFではなく毎回生成する使い捨てのランダム鍵である点。
 */
import { randomBytes } from '../keystore/randomBytes';

const AES_ALGO = 'AES-GCM';
const IV_LENGTH_BYTES = 12;
const KEY_LENGTH_BYTES = 32;

/** 送出用の封筒。iv/ct は base64（既存の暗号実装と揃えず base64url ではなく標準base64にする） */
interface PairingEnvelope {
  v: 1;
  iv: string;
  ct: string;
}

/** 32バイト乱数を base64url で返す。QRに載る形 */
export function generatePairingKey(): string {
  return base64UrlEncode(randomBytes(KEY_LENGTH_BYTES));
}

/** base64url の鍵から AES-GCM の CryptoKey を作る。不正な鍵なら null */
export async function importPairingKey(k: string): Promise<CryptoKey | null> {
  let raw: Uint8Array;
  try {
    raw = base64UrlDecode(k);
  } catch {
    return null;
  }
  if (raw.length !== KEY_LENGTH_BYTES) return null;

  try {
    return await crypto.subtle.importKey('raw', toArrayBuffer(raw), AES_ALGO, false, ['encrypt', 'decrypt']);
  } catch {
    return null;
  }
}

/** 平文を暗号化し、送出用の封筒（JSON文字列）にする */
export async function seal(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = randomBytes(IV_LENGTH_BYTES);
  const ciphertext = await crypto.subtle.encrypt({ name: AES_ALGO, iv }, key, new TextEncoder().encode(plaintext));

  const envelope: PairingEnvelope = {
    v: 1,
    iv: base64Encode(iv),
    ct: base64Encode(new Uint8Array(ciphertext)),
  };
  return JSON.stringify(envelope);
}

/** 封筒を復号する。復号失敗・改竄・形式不正はすべて null（例外を投げない） */
export async function open(key: CryptoKey, envelope: string): Promise<string | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(envelope);
  } catch {
    return null;
  }

  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  if (candidate.v !== 1) return null;
  if (typeof candidate.iv !== 'string' || typeof candidate.ct !== 'string') return null;

  let iv: Uint8Array;
  let ct: Uint8Array;
  try {
    iv = base64Decode(candidate.iv);
    ct = base64Decode(candidate.ct);
  } catch {
    return null;
  }

  try {
    const plaintext = await crypto.subtle.decrypt({ name: AES_ALGO, iv: toArrayBuffer(iv) }, key, toArrayBuffer(ct));
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(bytes.length);
  new Uint8Array(buf).set(bytes);
  return buf;
}

function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Decode(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlEncode(bytes: Uint8Array): string {
  return base64Encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (padded.length % 4)) % 4;
  return base64Decode(padded + '='.repeat(padLength));
}
