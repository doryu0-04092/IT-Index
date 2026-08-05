/**
 * Google Identity Services（GIS）のトークンクライアントを使ったOAuth。
 * 自前サーバーを持たない前提（要件定義書§3）なので、ブラウザだけで完結する
 * Implicit系のトークン取得のみを行う。リフレッシュトークンは得られないため、
 * 既知の制約（要件定義書§8「バックグラウンド同期はアプリを開いている間のみ」）どおり、
 * アクセストークンはメモリにのみ保持し、タブを閉じれば消える（APIキーと同じ扱い）。
 *
 * 実際の同意画面・認可はブラウザでの対話が要るためテスト対象外
 * （src/native/secureKeyStore.ts と同じ位置づけ）。
 *
 * 前提: このモジュールを実際に動かすには、開発者が Google Cloud Console で
 * OAuthクライアントID（種類: ウェブアプリケーション）を発行し、Drive API を有効化し、
 * スコープ https://www.googleapis.com/auth/drive.appdata を申請する必要がある。
 * このリポジトリ内のコードだけでは完結しない外部設定であり、未着手（docs/drive-sync.md §5）。
 */

const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

interface TokenResponse {
  access_token?: string;
  error?: string;
}

interface TokenClient {
  requestAccessToken(): void;
}

interface GoogleAccountsOAuth2 {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    callback: (response: TokenResponse) => void;
  }): TokenClient;
}

declare global {
  interface Window {
    google?: { accounts: { oauth2: GoogleAccountsOAuth2 } };
  }
}

export interface DriveAuthClient {
  isAvailable(): boolean;
  /** 直近取得したアクセストークン。無ければ null */
  getAccessToken(): string | null;
  /** 同意画面（必要なら）を出してアクセストークンを取得し、メモリにキャッシュする */
  requestAccessToken(): Promise<string>;
  clearAccessToken(): void;
}

export function createDriveAuthClient(clientId: string): DriveAuthClient {
  let accessToken: string | null = null;
  let scriptLoadPromise: Promise<void> | null = null;

  function loadGisScript(): Promise<void> {
    if (typeof window !== 'undefined' && window.google?.accounts?.oauth2) return Promise.resolve();
    if (scriptLoadPromise) return scriptLoadPromise;

    scriptLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = GIS_SCRIPT_URL;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Google Identity Servicesの読み込みに失敗しました'));
      document.head.appendChild(script);
    });
    return scriptLoadPromise;
  }

  return {
    isAvailable() {
      return typeof window !== 'undefined';
    },

    getAccessToken() {
      return accessToken;
    },

    clearAccessToken() {
      accessToken = null;
    },

    async requestAccessToken() {
      await loadGisScript();
      const google = window.google;
      if (!google) throw new Error('Google Identity Servicesが利用できません');

      return new Promise<string>((resolve, reject) => {
        const client = google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: SCOPE,
          callback: (response) => {
            if (response.error || !response.access_token) {
              reject(new Error(`Driveの認可に失敗しました: ${response.error ?? 'unknown error'}`));
              return;
            }
            accessToken = response.access_token;
            resolve(response.access_token);
          },
        });
        client.requestAccessToken();
      });
    },
  };
}
