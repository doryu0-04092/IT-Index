import { describe, expect, it } from 'vitest';
import { decodePairingPayload, encodePairingPayload, type PairingPayload } from './pairingCodec';

describe('encodePairingPayload / decodePairingPayload', () => {
  it('round-trips a valid payload', () => {
    const payload: PairingPayload = { v: 1, url: 'http://192.168.1.10:17321', k: 'abc123_-XYZ' };
    const decoded = decodePairingPayload(encodePairingPayload(payload));
    expect(decoded).toEqual(payload);
  });

  it('returns null for an empty string', () => {
    expect(decodePairingPayload('')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(decodePairingPayload('{ not valid json')).toBeNull();
  });

  it('returns null when v is not 1', () => {
    expect(decodePairingPayload(JSON.stringify({ v: 2, url: 'http://192.168.1.10:17321', k: 'abc' }))).toBeNull();
  });

  it('returns null for a URL from some other app (not http://host:port)', () => {
    expect(
      decodePairingPayload(JSON.stringify({ v: 1, url: 'https://example.com/some-other-app', k: 'abc' })),
    ).toBeNull();
    expect(decodePairingPayload(JSON.stringify({ v: 1, url: 'not-a-url-at-all', k: 'abc' }))).toBeNull();
    expect(decodePairingPayload(JSON.stringify({ v: 1, url: 'http://missing-port', k: 'abc' }))).toBeNull();
  });

  it('returns null when k is missing or empty', () => {
    expect(decodePairingPayload(JSON.stringify({ v: 1, url: 'http://192.168.1.10:17321', k: '' }))).toBeNull();
    expect(decodePairingPayload(JSON.stringify({ v: 1, url: 'http://192.168.1.10:17321' }))).toBeNull();
  });

  it('returns null for a completely unrelated JSON payload (some other QR app)', () => {
    expect(decodePairingPayload(JSON.stringify({ foo: 'bar' }))).toBeNull();
    expect(decodePairingPayload(JSON.stringify(['not', 'an', 'object']))).toBeNull();
  });
});
