import jsQR from 'jsqr';
import QRCode from 'qrcode';

/**
 * QRコードの生成と読み取り(#182の鍵受け渡し)。
 * v1の `src/manualSync/qrCodec.ts` をそのまま移植したもので、テストも一緒に持ってきている。
 *
 * v1では**同期データ全体**をQRに載せようとしていたため「1枚に収まらない」ケースが常態で、
 * ファイル書き出しへ誘導する作りだった。v2で載せるのは**データ鍵だけ**(base64urlで44文字
 * 程度)なので容量には十分余裕がある——それでも失敗経路は残す(想定外の入力で例外を投げて
 * 画面を壊さないため)。
 *
 * SVG文字列で生成する(Canvas/DOM不要のため、この関数自体はNode環境でもテストできる)。
 * 実際のカメラ取得は `sync/qrScanner.ts` が担当し、そちらはテスト対象外。
 */

export type QrEncodeResult = { ok: true; svg: string } | { ok: false; reason: string };

export async function encodeAsQrSvg(content: string): Promise<QrEncodeResult> {
  try {
    const svg = await QRCode.toString(content, { type: 'svg', errorCorrectionLevel: 'M' });
    return { ok: true, svg };
  } catch {
    return {
      ok: false,
      reason: `QRコードを作れませんでした(${content.length}文字)。数字コードでの受け渡しをお使いください。`,
    };
  }
}

/**
 * カメラから取得した1フレーム分のRGBAピクセルデータをデコードする。
 * jsQRへの薄いラッパーで、純粋にデータ入出力のみなのでテストできる。
 */
export function decodeQrFromImageData(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): string | null {
  const result = jsQR(data, width, height);
  return result?.data ?? null;
}
