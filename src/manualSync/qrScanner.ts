import { decodeQrFromImageData } from './qrCodec';

/**
 * カメラ映像からQRコードを継続的に読み取る層。getUserMedia・video要素・
 * requestAnimationFrame ループに依存するためテスト対象外
 * （src/keystore/webauthn.ts と同じ位置づけ）。デコード自体は qrCodec.ts でテスト済み。
 */

export function isCameraAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

/**
 * video要素にカメラ映像を流し込み、QRを検出するたびに onDecode を呼ぶ。
 * 呼び出し側は戻り値の stop() を、画面を離れるときなどに必ず呼ぶこと
 * （カメラを掴んだままにしない）。
 */
export async function startQrScan(video: HTMLVideoElement, onDecode: (text: string) => void): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  video.srcObject = stream;
  await video.play();

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('canvas 2d コンテキストを取得できませんでした');
  }

  let stopped = false;
  let frameHandle: number;

  function tick() {
    if (stopped) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx!.drawImage(video, 0, 0, canvas.width, canvas.height);
      const frame = ctx!.getImageData(0, 0, canvas.width, canvas.height);
      const text = decodeQrFromImageData(frame.data, frame.width, frame.height);
      if (text) {
        onDecode(text);
      }
    }
    frameHandle = requestAnimationFrame(tick);
  }
  frameHandle = requestAnimationFrame(tick);

  return () => {
    stopped = true;
    cancelAnimationFrame(frameHandle);
    stream.getTracks().forEach((t) => t.stop());
  };
}
