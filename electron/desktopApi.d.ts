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

  /**
   * 相手の待ち受けサーバーへ封筒をPOSTし、応答の本文を受け取る（読み取り役として使う）。
   *
   * レンダラーから直接 fetch しないのは、index.html の CSP `connect-src 'self'` が
   * LAN内アドレスへの接続を遮断するため。CSPを緩めるとPC版全体の防御が下がるので、
   * 代わりにメインプロセスから送る（Android側が CapacitorHttp でネイティブ送信して
   * 同じ制約を回避しているのと同じ考え方）。
   *
   * 接続先は呼び出し側が検証済みのプライベートアドレスに限る（src/pairing/pairingCodec.ts）。
   * メインプロセス側でも同じ検証を行い、二重に防ぐ。
   */
  postPairing(
    url: string,
    body: string
  ): Promise<
    | { ok: true; body: string }
    | { ok: false; kind: 'transport'; reason: string }
    | { ok: false; kind: 'status'; status: number }
  >;
}

declare global {
  interface Window {
    desktop?: DesktopApi;
  }
}

export {};
