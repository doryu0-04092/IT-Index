import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import { buildKeyQrPayload, generateDataKey, parseKeyQrPayload } from './syncCrypto';
import { decodeQrFromImageData, encodeAsQrSvg } from './qrCodec';

/**
 * 実カメラが無いため、qrcode.create() のモジュール行列を自前でRGBAピクセルに
 * ラスタライズしてから jsQR に渡す。生成→読み取りの実経路をNode上で確認できる
 * (v1 src/manualSync/qrCodec.test.ts から移植)。
 */
function rasterizeQr(text: string): { data: Uint8ClampedArray; width: number; height: number } {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const scale = 4;
  const quiet = 4; // クワイエットゾーン(モジュール単位)
  const dim = (size + quiet * 2) * scale;

  const data = new Uint8ClampedArray(dim * dim * 4).fill(255); // 白背景・不透明

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (!qr.modules.get(row, col)) continue;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const px = (col + quiet) * scale + sx;
          const py = (row + quiet) * scale + sy;
          const idx = (py * dim + px) * 4;
          data[idx] = 0;
          data[idx + 1] = 0;
          data[idx + 2] = 0;
          data[idx + 3] = 255;
        }
      }
    }
  }
  return { data, width: dim, height: dim };
}

describe('encodeAsQrSvg', () => {
  it('短い内容をSVGのQRコードにする', async () => {
    const result = await encodeAsQrSvg('{"hello":"world"}');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.svg).toContain('<svg');
  });

  it('容量を超える内容では例外を投げずに失敗を返す', async () => {
    const result = await encodeAsQrSvg('x'.repeat(5000));
    expect(result.ok).toBe(false);
  });
});

describe('decodeQrFromImageData', () => {
  it('生成→ラスタライズ→読み取りが往復する', () => {
    const original = JSON.stringify({ v: 1, dk: 'example' });
    const { data, width, height } = rasterizeQr(original);
    expect(decodeQrFromImageData(data, width, height)).toBe(original);
  });

  it('QRが写っていない画像ではnullを返す', () => {
    const blank = new Uint8ClampedArray(100 * 100 * 4).fill(255);
    expect(decodeQrFromImageData(blank, 100, 100)).toBeNull();
  });
});

describe('鍵の受け渡し(QR経路の通し)', () => {
  it('データ鍵をQRにして読み取ると、同じ鍵が復元される', async () => {
    const dataKey = generateDataKey();
    const content = buildKeyQrPayload(dataKey);

    // 実際にQRへ収まることを確かめる(鍵だけなので容量に余裕がある)
    const encoded = await encodeAsQrSvg(content);
    expect(encoded.ok).toBe(true);

    const { data, width, height } = rasterizeQr(content);
    const decoded = decodeQrFromImageData(data, width, height);
    expect(decoded).toBe(content);
    expect(await parseKeyQrPayload(decoded!)).toBe(dataKey);
  });
});
