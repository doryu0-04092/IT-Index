import type { RawFile } from './sync';

/**
 * ブラウザのFile APIを直接使う層。DOM依存のためテスト対象外
 * （src/keystore/webauthn.ts と同じ位置づけ）。src/manualSync/sync.ts はテキストの
 * 受け渡しだけで完結するので、こちらは薄いI/Oグルーだけにしてある。
 */

/** file.content を利用者のダウンロードフォルダへ保存させる（ブラウザの標準ダウンロードUI） */
export function downloadRawFile(file: RawFile): void {
  const blob = new Blob([file.content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.name;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** <input type="file" multiple> 等で選ばれた File[] からテキストを読み出す */
export async function readFilesAsRawFiles(files: FileList | File[]): Promise<RawFile[]> {
  return Promise.all(Array.from(files).map(async (file) => ({ name: file.name, content: await file.text() })));
}
