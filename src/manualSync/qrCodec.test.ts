import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import { decodeQrFromImageData, encodeAsQrSvg } from './qrCodec';

/**
 * 実カメラが無いため、qrcode.create() のモジュール行列を自前でRGBAピクセルに
 * ラスタライズしてから jsQR に渡す。エンコード→デコードの実経路をNode上で確認できる。
 */
function rasterizeQr(text: string): { data: Uint8ClampedArray; width: number; height: number } {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const scale = 4;
  const quiet = 4; // クワイエットゾーン（モジュール単位）
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
  it('encodes short content into an SVG QR code', async () => {
    const result = await encodeAsQrSvg('{"hello":"world"}');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.svg).toContain('<svg');
  });

  it('fails gracefully when content exceeds QR capacity', async () => {
    const tooLong = 'x'.repeat(5000);
    const result = await encodeAsQrSvg(tooLong);
    expect(result.ok).toBe(false);
  });
});

describe('decodeQrFromImageData', () => {
  it('decodes a real encode -> rasterize -> decode round trip', () => {
    const original = JSON.stringify({ deviceId: 'device-A', notes: [{ termId: 'tcp/ip', body: 'hi' }] });
    const { data, width, height } = rasterizeQr(original);

    const decoded = decodeQrFromImageData(data, width, height);
    expect(decoded).toBe(original);
  });

  it('returns null for image data with no QR code', () => {
    const blank = new Uint8ClampedArray(100 * 100 * 4).fill(255);
    expect(decodeQrFromImageData(blank, 100, 100)).toBeNull();
  });
});
