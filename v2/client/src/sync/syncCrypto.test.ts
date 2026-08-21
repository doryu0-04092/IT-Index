import { describe, expect, it } from 'vitest';
import {
  buildKeyQrPayload,
  decryptSyncPayload,
  encryptSyncPayload,
  formatTransferCode,
  generateDataKey,
  generateTransferCode,
  importDataKey,
  isSyncEnvelope,
  normalizeTransferCode,
  parseKeyQrPayload,
  TRANSFER_CODE_DIGITS,
  unwrapDataKey,
  wrapDataKey,
  type SyncEnvelope,
} from './syncCrypto';

/** 実際に同期で流れる形に近いJSON */
const SAMPLE_PAYLOAD = JSON.stringify({
  syncSchemaVersion: 1,
  deviceId: 'dev-1',
  writtenAt: 1_700_000_000_000,
  notes: [{ termId: 'dns', body: '名前解決の仕組み', updatedAt: 1, lastEditedBy: 'dev-1', noteHistory: [] }],
  asks: [],
  aiTerms: [],
});

describe('データ鍵', () => {
  it('生成した鍵は読み込める', async () => {
    const key = generateDataKey();
    expect(await importDataKey(key)).not.toBeNull();
  });

  it('毎回異なる鍵を生成する', () => {
    expect(generateDataKey()).not.toBe(generateDataKey());
  });

  it('鍵長が32バイトでない値・壊れた値は読み込めない', async () => {
    expect(await importDataKey('')).toBeNull();
    expect(await importDataKey('c2hvcnQ')).toBeNull(); // 短すぎる
    expect(await importDataKey('!!!not-base64!!!')).toBeNull();
  });
});

describe('encryptSyncPayload / decryptSyncPayload', () => {
  it('暗号化して復号すると元に戻る', async () => {
    const key = (await importDataKey(generateDataKey()))!;
    const envelope = JSON.parse(await encryptSyncPayload(key, SAMPLE_PAYLOAD)) as SyncEnvelope;
    expect(await decryptSyncPayload(key, envelope)).toBe(SAMPLE_PAYLOAD);
  });

  it('暗号文に平文が現れない(サーバー上で判読できないこと)', async () => {
    const key = (await importDataKey(generateDataKey()))!;
    const serialized = await encryptSyncPayload(key, SAMPLE_PAYLOAD);
    expect(serialized).not.toContain('名前解決の仕組み');
    expect(serialized).not.toContain('dev-1');
  });

  it('同じ内容でも毎回異なる暗号文になる(IVが毎回変わる)', async () => {
    const key = (await importDataKey(generateDataKey()))!;
    const a = await encryptSyncPayload(key, SAMPLE_PAYLOAD);
    const b = await encryptSyncPayload(key, SAMPLE_PAYLOAD);
    expect(a).not.toBe(b);
  });

  it('別の鍵では復号できない(nullを返し、例外を投げない)', async () => {
    const key = (await importDataKey(generateDataKey()))!;
    const otherKey = (await importDataKey(generateDataKey()))!;
    const envelope = JSON.parse(await encryptSyncPayload(key, SAMPLE_PAYLOAD)) as SyncEnvelope;
    expect(await decryptSyncPayload(otherKey, envelope)).toBeNull();
  });

  it('改竄された暗号文は復号できない(AES-GCMの認証が効く)', async () => {
    const key = (await importDataKey(generateDataKey()))!;
    const envelope = JSON.parse(await encryptSyncPayload(key, SAMPLE_PAYLOAD)) as SyncEnvelope;
    const tampered: SyncEnvelope = { ...envelope, ct: `A${envelope.ct.slice(1)}` };
    expect(await decryptSyncPayload(key, tampered)).toBeNull();
  });

  it('未知の版のエンベロープは復号しない', async () => {
    const key = (await importDataKey(generateDataKey()))!;
    const envelope = JSON.parse(await encryptSyncPayload(key, SAMPLE_PAYLOAD)) as SyncEnvelope;
    expect(await decryptSyncPayload(key, { ...envelope, encSchemaVersion: 99 })).toBeNull();
  });
});

describe('isSyncEnvelope', () => {
  it('エンベロープを判別する', async () => {
    const key = (await importDataKey(generateDataKey()))!;
    const envelope = JSON.parse(await encryptSyncPayload(key, SAMPLE_PAYLOAD));
    expect(isSyncEnvelope(envelope)).toBe(true);
  });

  it('平文の同期ファイルをエンベロープと誤判定しない(移行期間に読み飛ばさないため)', () => {
    expect(isSyncEnvelope(JSON.parse(SAMPLE_PAYLOAD))).toBe(false);
  });

  it('オブジェクトでない値・欠けたフィールドは弾く', () => {
    expect(isSyncEnvelope(null)).toBe(false);
    expect(isSyncEnvelope('文字列')).toBe(false);
    expect(isSyncEnvelope({ encSchemaVersion: 1, alg: 'A256GCM', iv: 'x' })).toBe(false);
    expect(isSyncEnvelope({ encSchemaVersion: 1, alg: 'その他', iv: 'x', ct: 'y' })).toBe(false);
  });
});

describe('QRでの受け渡し', () => {
  it('組み立てた文字列から同じ鍵を取り出せる', async () => {
    const dataKey = generateDataKey();
    expect(await parseKeyQrPayload(buildKeyQrPayload(dataKey))).toBe(dataKey);
  });

  it('別のQR(JSONでない・別形式)を読んだ場合はnull', async () => {
    expect(await parseKeyQrPayload('https://example.com')).toBeNull();
    expect(await parseKeyQrPayload(JSON.stringify({ v: 2, dk: generateDataKey() }))).toBeNull();
    expect(await parseKeyQrPayload(JSON.stringify({ v: 1 }))).toBeNull();
  });

  it('形式は合っていても鍵として使えない値は弾く', async () => {
    expect(await parseKeyQrPayload(JSON.stringify({ v: 1, dk: 'c2hvcnQ' }))).toBeNull();
  });
});

describe('受け渡しコード', () => {
  it('8桁の数字を生成する', () => {
    const code = generateTransferCode();
    expect(code).toMatch(/^\d{8}$/);
    expect(code.length).toBe(TRANSFER_CODE_DIGITS);
  });

  it('表示用に4桁ずつ区切る', () => {
    expect(formatTransferCode('12345678')).toBe('1234 5678');
  });

  it('入力から数字以外を落とす(空白・ハイフンを許容する)', () => {
    expect(normalizeTransferCode('1234 5678')).toBe('12345678');
    expect(normalizeTransferCode('1234-5678')).toBe('12345678');
    expect(normalizeTransferCode('12345678901')).toBe('12345678');
  });
});

describe('wrapDataKey / unwrapDataKey', () => {
  it('正しいコードなら鍵を取り出せる', async () => {
    const dataKey = generateDataKey();
    const wrapped = await wrapDataKey(dataKey, '12345678');
    expect(await unwrapDataKey(wrapped, '12345678')).toBe(dataKey);
  });

  it('1桁違うコードでは開けない', async () => {
    const wrapped = await wrapDataKey(generateDataKey(), '12345678');
    expect(await unwrapDataKey(wrapped, '12345679')).toBeNull();
  });

  it('包んだ結果に鍵そのものが現れない(サーバーへ渡るのは暗号文とsaltだけ)', async () => {
    const dataKey = generateDataKey();
    const wrapped = await wrapDataKey(dataKey, '12345678');
    expect(wrapped.wrappedDk).not.toContain(dataKey);
    expect(wrapped.salt).not.toContain(dataKey);
  });

  it('同じ鍵・同じコードでも毎回異なる暗号文になる(saltとIVが毎回変わる)', async () => {
    const dataKey = generateDataKey();
    const a = await wrapDataKey(dataKey, '12345678');
    const b = await wrapDataKey(dataKey, '12345678');
    expect(a.wrappedDk).not.toBe(b.wrappedDk);
    expect(a.salt).not.toBe(b.salt);
  });

  it('壊れた値を渡してもnullを返す(例外を投げない)', async () => {
    expect(await unwrapDataKey({ salt: '!!!', wrappedDk: '!!!' }, '12345678')).toBeNull();
    expect(await unwrapDataKey({ salt: 'AAAA', wrappedDk: 'AA' }, '12345678')).toBeNull();
  });
});
