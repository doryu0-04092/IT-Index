/**
 * docs/requirements.md §5.6 層2「パスキー紐付け」の暗号化部分。
 * WebAuthn PRF の出力（32バイト）をそのまま AES-256-GCM の鍵material として使う。
 * Web Crypto API のみに依存するので Node / ブラウザどちらでも動く（Vitestで固める対象）。
 */

import { randomBytes } from './randomBytes';

const AES_ALGO = 'AES-GCM';
const IV_LENGTH_BYTES = 12;

export interface EncryptedPayload {
  ciphertext: ArrayBuffer;
  iv: Uint8Array<ArrayBuffer>;
}

export async function deriveAesKeyFromPrfOutput(prfOutput: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', prfOutput, AES_ALGO, false, ['encrypt', 'decrypt']);
}

export async function encryptApiKey(key: CryptoKey, apiKey: string): Promise<EncryptedPayload> {
  const iv = randomBytes(IV_LENGTH_BYTES);
  const ciphertext = await crypto.subtle.encrypt({ name: AES_ALGO, iv }, key, new TextEncoder().encode(apiKey));
  return { ciphertext, iv };
}

export async function decryptApiKey(key: CryptoKey, payload: EncryptedPayload): Promise<string> {
  const plaintext = await crypto.subtle.decrypt({ name: AES_ALGO, iv: payload.iv }, key, payload.ciphertext);
  return new TextDecoder().decode(plaintext);
}
