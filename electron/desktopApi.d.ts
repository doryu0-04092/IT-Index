/**
 * Electronのpreloadがrendererに公開するAPIの契約。
 * この型定義は electron/ 配下に置く（src/ は触らない）。
 */
export interface DesktopApi {
  isDesktop: true;

  /**
   * ローカルHTTPサーバーを起動し、LAN内から到達できるURLを返す。
   * LAN IPが取得できない場合は { url: null, reason: "日本語の説明" } を返す。
   */
  startPairingServer(): Promise<{ url: string | null; reason?: string }>;

  /** サーバーを停止する。二重呼び出しでも失敗しない。 */
  stopPairingServer(): Promise<void>;

  /**
   * POST /sync を受信したときに呼ばれる。
   * 戻り値の解除関数を呼ぶとリスナーが外れる。
   */
  onPairingRequest(cb: (requestId: string, body: string) => void): () => void;

  /** onPairingRequest への応答。body が null ならエラー応答（HTTP 400）を返す。 */
  respondPairing(requestId: string, body: string | null): Promise<void>;
}

declare global {
  interface Window {
    desktop?: DesktopApi;
  }
}

export {};
