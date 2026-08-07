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

  // 悪意あるQRを読ませるだけで全スナップショットを外部へ送信させられる経路を塞ぐ。
  // 鍵もQRに載っている＝攻撃者が用意したものなので、暗号化は防御にならない。
  // このホスト制限が唯一の防波堤なので、テストで固定する。
  it('rejects hosts outside private LAN ranges', () => {
    const outside = [
      'http://attacker.example.com:8080',
      'http://93.184.216.34:8080',
      'http://8.8.8.8:80',
      'http://172.32.0.1:17321', // 172.16.0.0/12 の外側
      'http://192.169.1.10:17321', // 192.168.0.0/16 の外側
      'http://11.0.0.1:17321',
    ];
    for (const url of outside) {
      expect(decodePairingPayload(JSON.stringify({ v: 1, url, k: 'a'.repeat(43) }))).toBeNull();
    }
  });

  it('accepts hosts inside private LAN ranges', () => {
    const inside = [
      'http://192.168.1.10:17321',
      'http://10.0.0.5:17321',
      'http://172.16.0.1:17321',
      'http://172.31.255.254:17321',
      'http://169.254.1.1:17321',
      'http://127.0.0.1:17321',
    ];
    for (const url of inside) {
      expect(decodePairingPayload(JSON.stringify({ v: 1, url, k: 'a'.repeat(43) }))?.url).toBe(url);
    }
  });
});
