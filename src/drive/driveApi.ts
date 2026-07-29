/**
 * Google Drive の appDataFolder（要件定義書§5.6層5「Driveは drive.appdata のみ」）に対する
 * 薄いREST v3ラッパー。実際の疎通は認可済みトークンとネットワークが要るためテスト対象外
 * （src/keystore/webauthn.ts と同じ位置づけ）。オーケストレーション側（src/drive/sync.ts）は
 * このインターフェースだけに依存させ、テスト時はフェイク実装を注入する。
 */

export interface DriveFileMeta {
  id: string;
  name: string;
}

export interface DriveFilesClient {
  /** appDataFolder 内のファイル一覧（id・nameのみ） */
  list(): Promise<DriveFileMeta[]>;
  download(fileId: string): Promise<string>;
  /** existingFileId が無ければ新規作成、あれば中身を上書きする */
  upsert(fileName: string, content: string, existingFileId?: string): Promise<void>;
}

const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';

export function createDriveFilesClient(getAccessToken: () => string | null): DriveFilesClient {
  function authHeaders(): Record<string, string> {
    const token = getAccessToken();
    if (!token) throw new Error('Driveのアクセストークンがありません');
    return { authorization: `Bearer ${token}` };
  }

  return {
    async list() {
      const url = `${FILES_URL}?spaces=appDataFolder&fields=files(id,name)&pageSize=100`;
      const res = await fetch(url, { headers: authHeaders() });
      if (!res.ok) throw new Error(`Driveのファイル一覧取得に失敗しました（${res.status}）`);
      const data = (await res.json()) as { files?: DriveFileMeta[] };
      return data.files ?? [];
    },

    async download(fileId) {
      const res = await fetch(`${FILES_URL}/${fileId}?alt=media`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`Driveのファイル取得に失敗しました（${res.status}）`);
      return res.text();
    },

    async upsert(fileName, content, existingFileId) {
      if (existingFileId) {
        const res = await fetch(`${UPLOAD_URL}/${existingFileId}?uploadType=media`, {
          method: 'PATCH',
          headers: { ...authHeaders(), 'content-type': 'application/json' },
          body: content,
        });
        if (!res.ok) throw new Error(`Driveのファイル更新に失敗しました（${res.status}）`);
        return;
      }

      const boundary = 'it-index-sync-boundary';
      const metadata = JSON.stringify({ name: fileName, parents: ['appDataFolder'] });
      const body =
        `--${boundary}\r\n` +
        'content-type: application/json; charset=UTF-8\r\n\r\n' +
        `${metadata}\r\n` +
        `--${boundary}\r\n` +
        'content-type: application/json\r\n\r\n' +
        `${content}\r\n` +
        `--${boundary}--`;

      const res = await fetch(`${UPLOAD_URL}?uploadType=multipart`, {
        method: 'POST',
        headers: { ...authHeaders(), 'content-type': `multipart/related; boundary=${boundary}` },
        body,
      });
      if (!res.ok) throw new Error(`Driveのファイル作成に失敗しました（${res.status}）`);
    },
  };
}
