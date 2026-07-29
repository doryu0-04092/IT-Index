import { describe, expect, it } from 'vitest';
import { decryptApiKey, deriveAesKeyFromPrfOutput, encryptApiKey } from './crypto';
import { randomBytes } from './randomBytes';

function fakePrfOutput(): ArrayBuffer {
  return randomBytes(32).buffer;
}

describe('crypto', () => {
  it('round-trips an API key through encrypt/decrypt with the same key', async () => {
    const prfOutput = fakePrfOutput();
    const key = await deriveAesKeyFromPrfOutput(prfOutput);

    const payload = await encryptApiKey(key, 'sk-ant-super-secret');
    const decrypted = await decryptApiKey(key, payload);

    expect(decrypted).toBe('sk-ant-super-secret');
  });

  it('fails to decrypt with a different key (wrong passkey / device)', async () => {
    const key1 = await deriveAesKeyFromPrfOutput(fakePrfOutput());
    const key2 = await deriveAesKeyFromPrfOutput(fakePrfOutput());

    const payload = await encryptApiKey(key1, 'sk-ant-super-secret');

    await expect(decryptApiKey(key2, payload)).rejects.toThrow();
  });

  it('produces a different ciphertext each time (random IV)', async () => {
    const key = await deriveAesKeyFromPrfOutput(fakePrfOutput());

    const a = await encryptApiKey(key, 'same-plaintext');
    const b = await encryptApiKey(key, 'same-plaintext');

    expect(new Uint8Array(a.ciphertext)).not.toEqual(new Uint8Array(b.ciphertext));
  });
});
