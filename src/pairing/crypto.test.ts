import { describe, expect, it } from 'vitest';
import { generatePairingKey, importPairingKey, open, seal } from './crypto';

describe('seal / open', () => {
  it('round-trips plaintext through seal then open', async () => {
    const key = await importPairingKey(generatePairingKey());
    expect(key).not.toBeNull();

    const envelope = await seal(key!, 'hello, pairing');
    const opened = await open(key!, envelope);

    expect(opened).toBe('hello, pairing');
  });

  it('returns null when opening with a different key', async () => {
    const keyA = await importPairingKey(generatePairingKey());
    const keyB = await importPairingKey(generatePairingKey());
    expect(keyA).not.toBeNull();
    expect(keyB).not.toBeNull();

    const envelope = await seal(keyA!, 'secret');
    const opened = await open(keyB!, envelope);

    expect(opened).toBeNull();
  });

  it('returns null for a malformed envelope JSON', async () => {
    const key = await importPairingKey(generatePairingKey());
    expect(key).not.toBeNull();

    const opened = await open(key!, '{ not valid json');
    expect(opened).toBeNull();
  });

  it('returns null for an empty string envelope', async () => {
    const key = await importPairingKey(generatePairingKey());
    expect(key).not.toBeNull();

    const opened = await open(key!, '');
    expect(opened).toBeNull();
  });

  it('returns null for a tampered ciphertext', async () => {
    const key = await importPairingKey(generatePairingKey());
    expect(key).not.toBeNull();

    const envelope = await seal(key!, 'secret payload');
    const parsed = JSON.parse(envelope);
    // ctの先頭バイトを変えて改竄する
    parsed.ct = parsed.ct.slice(0, -4) + (parsed.ct.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');

    const opened = await open(key!, JSON.stringify(parsed));
    expect(opened).toBeNull();
  });

  it('importPairingKey returns null for an invalid key string', async () => {
    expect(await importPairingKey('not-a-valid-base64url-key')).toBeNull();
    expect(await importPairingKey('')).toBeNull();
  });

  it('generatePairingKey produces a usable 32-byte key each time', async () => {
    const k1 = generatePairingKey();
    const k2 = generatePairingKey();
    expect(k1).not.toBe(k2);
    expect(await importPairingKey(k1)).not.toBeNull();
  });
});
