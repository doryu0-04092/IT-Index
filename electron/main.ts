import { app, BrowserWindow, ipcMain, net, protocol, session } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { postPairing } from './pairingClient.js';
import { PairingServer } from './pairingServer.js';

// CommonJS で出力するため __dirname はそのまま使える（import.meta は使えない）

/**
 * 本番ビルドを配信する独自スキーム。
 *
 * loadFile() で読むと file:// オリジンになるが、**Chromiumは file:// での fetch() を
 * 全面的に禁止している**ため、初期辞書（/seed/terms.json）の取り込みが必ず失敗する。
 * さらに index.html の CSP は `default-src 'self'` を使っており、file:// では 'self' が
 * 何も指さないため script/style も本来の意図どおりに保護できない。
 *
 * standard(=通常のURL解釈) かつ secure(=安全なコンテキスト扱い) なスキームを登録して
 * dist/ を配信すると、オリジンが app://- になり fetch も CSP の 'self' も正しく働く。
 * WebCrypto など secure context を要求するAPIが使える点でも file:// より正しい。
 */
const APP_SCHEME = 'app';

// app.whenReady() より前に呼ぶ必要がある
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

const pairingServer = new PairingServer();
let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 開発時はViteのdev serverを、本番ビルドでは app://- 経由で dist/ を読む。
  // loadFile() を使うと file:// になり、fetch() が禁止されて辞書を取り込めない。
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadURL(`${APP_SCHEME}://-/index.html`);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** dist/ を app://- として配信する。app.whenReady() の後に1度だけ呼ぶ。 */
function registerAppProtocol(): void {
  const root = path.join(__dirname, '../dist');

  protocol.handle(APP_SCHEME, async (request) => {
    const { pathname } = new URL(request.url);
    const requested = decodeURIComponent(pathname);
    const resolved = path.join(root, requested);

    // dist/ の外を指す要求は拒否する（../ を含むパスで任意のファイルを読ませない）
    const relative = path.relative(root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      return await net.fetch(pathToFileURL(resolved).toString());
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });
}

function setupPermissionHandler(): void {
  // QRコードをWebカメラで読む機能のため、カメラ権限のみ許可する
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'media') {
      callback(true);
      return;
    }
    callback(false);
  });
}

function setupPairingIpc(): void {
  pairingServer.setRequestHandler((requestId, body) => {
    mainWindow?.webContents.send('pairing:request', requestId, body);
  });

  ipcMain.handle('pairing:start', () => pairingServer.start());
  ipcMain.handle('pairing:stop', () => pairingServer.stop());
  ipcMain.handle('pairing:respond', (_event, requestId: string, body: string | null) =>
    pairingServer.respond(requestId, body)
  );
  ipcMain.handle('pairing:post', (_event, url: string, body: string) => postPairing(url, body));
}

void app.whenReady().then(() => {
  registerAppProtocol();
  setupPermissionHandler();
  setupPairingIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  void pairingServer.stop();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
