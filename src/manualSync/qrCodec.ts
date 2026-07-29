import jsQR from 'jsqr';
import QRCode from 'qrcode';

/**
 * QRコードでの同期（案2）。v1では複数枚に分割する「アニメーションQR」は実装しない
 * （専用ライブラリが枯れていない・実装コストが高いため）。1枚に収まらない場合は
 * ファイル書き出し方式（manualSync/fileTransport.ts）に誘導する。
 *
 * SVG文字列で生成する（Canvas/DOM不要のため、この関数自体はNode環境でもテストできる）。
 */

export type QrEncodeResult = { ok: true; svg: string } | { ok: false; reason: string };

export async function encodeAsQrSvg(content: string): Promise<QrEncodeResult> {
  try {
    const svg = await QRCode.toString(content, { type: 'svg', errorCorrectionLevel: 'M' });
    return { ok: true, svg };
  } catch {
    return {
      ok: false,
      reason: `QRコード1枚に収まりませんでした（${content.length}文字）。ファイル書き出しをお使いください。`,
    };
  }
}

/**
 * カメラから取得した1フレーム分のRGBAピクセルデータをデコードする。
 * jsQRへの薄いラッパーで、純粋にデータ入出力のみなのでテストできる
 * （実際のカメラ取得は src/manualSync/qrScanner.ts が担当・そちらはテスト対象外）。
 */
export function decodeQrFromImageData(data: Uint8ClampedArray, width: number, height: number): string | null {
  const result = jsQR(data, width, height);
  return result?.data ?? null;
}
