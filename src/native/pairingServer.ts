import { registerPlugin } from '@capacitor/core';

/**
 * ネイティブプラグイン `PairingServer` のTypeScript契約。
 *
 * Android版のLAN内直接同期における「搬送」だけを担うプラグイン。
 * 暗号化・JSONの解釈・マージは一切行わない（それらは src/pairing/ が担当済み）。
 *
 * PC版（electron/pairingServer.ts）と対称の契約になるよう意図している。
 * 実装は android/app/src/main/java/com/itindex/app/pairing/PairingServerPlugin.java を参照。
 */
export interface PairingServerPlugin {
  /**
   * 待ち受けを開始し、LAN内から到達できるURLを返す。例 "http://192.168.1.42:17321"
   * LAN IPが取れない等で起動できなければ { url: null, reason: "日本語の説明" } を返す。
   */
  start(): Promise<{ url: string | null; reason?: string }>;

  /** 停止する。二重呼び出しでも失敗しないこと。 */
  stop(): Promise<void>;

  /** 受信への応答。body が null ならエラー応答（HTTP 400）を返す。 */
  respond(options: { requestId: string; body: string | null }): Promise<void>;

  addListener(
    eventName: 'pairingRequest',
    listener: (event: { requestId: string; body: string }) => void
  ): Promise<{ remove: () => Promise<void> }>;
}

export const PairingServer = registerPlugin<PairingServerPlugin>('PairingServer');
