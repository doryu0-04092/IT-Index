import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import type { RawFile } from '../manualSync/sync';

/**
 * Android版の「連携」ファイルエクスポート。PC版・Web版が使う`downloadRawFile`
 * （ブラウザの`<a download>`）はCapacitorのWebView内では機能しないため
 * （通常のブラウザのようなダウンロードUI・保存先が存在しない）、Capacitorの
 * Filesystem/Shareプラグインでキャッシュへ書き出してからOSの共有シートを開く。
 */
export async function shareRawFile(file: RawFile): Promise<void> {
  const written = await Filesystem.writeFile({
    path: file.name,
    data: file.content,
    directory: Directory.Cache,
    encoding: Encoding.UTF8,
  });
  await Share.share({
    title: file.name,
    url: written.uri,
  });
}
