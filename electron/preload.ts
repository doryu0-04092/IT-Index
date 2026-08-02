import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi } from './desktopApi.js';

/**
 * contextBridge経由で公開するのは window.desktop だけ。
 * Nodeの機能を丸ごと露出させない。
 */
const desktopApi: DesktopApi = {
  isDesktop: true,

  startPairingServer: () => ipcRenderer.invoke('pairing:start'),

  stopPairingServer: () => ipcRenderer.invoke('pairing:stop'),

  onPairingRequest: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, requestId: string, body: string) => {
      cb(requestId, body);
    };
    ipcRenderer.on('pairing:request', listener);
    return () => {
      ipcRenderer.removeListener('pairing:request', listener);
    };
  },

  respondPairing: (requestId, body) => ipcRenderer.invoke('pairing:respond', requestId, body),

  postPairing: (url, body) => ipcRenderer.invoke('pairing:post', url, body),
};

contextBridge.exposeInMainWorld('desktop', desktopApi);
