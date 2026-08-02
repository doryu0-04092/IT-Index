import { app, BrowserWindow, ipcMain, session } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PairingServer } from './pairingServer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

  // 開発時はViteのdev serverを、本番ビルドではdist/を読む
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
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
}

void app.whenReady().then(() => {
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
