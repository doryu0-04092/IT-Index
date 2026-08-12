/**
 * 接続先サーバー(セルフホスト)のURL設定(要件定義書§4「提供形態」・§8「接続先サーバー設定UI」)。
 * apiClient.tsのapiUrl()がここのgetServerBaseUrl()を読む唯一の場所であり、認証・同期・AIの
 * 全fetchはapiFetch()経由でapiUrl()を通るため、この1点を書き換えるだけで基底URLが
 * 全リクエストへ一元的に反映される(接続テストに通った時だけ保存する。保存前は反映しない)。
 *
 * sync/tokenStore.ts・sync/apiKeyStore.tsと同じ流儀でlocalStorageにキー名固定で置く。
 * 未設定(既定)は公式ホスト=同一オリジンを表し、apiClient.ts側でimport.meta.env.VITE_API_BASE
 * (未設定なら相対パス'/api')にフォールバックする。
 */
const SERVER_BASE_URL_KEY = 'it-index-v2:server-base-url';

export interface ServerUrlOk {
  ok: true;
  /** 末尾スラッシュを除いた正規化済みoriginベースURL(パス部分も許容するがそのまま残す) */
  normalized: string;
}
export interface ServerUrlError {
  ok: false;
  error: string;
}

/**
 * https必須(localhostのみhttpも許可。開発時のwrangler dev/vite dev向け)。
 * 末尾スラッシュは正規化(除去)する。
 */
export function validateServerUrl(input: string): ServerUrlOk | ServerUrlError {
  const trimmed = input.trim();
  if (trimmed === '') {
    return { ok: false, error: 'サーバーURLを入力してください' };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: 'URLの形式が正しくありません(https://example.workers.devの形で入力してください)' };
  }

  const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalhost)) {
    return { ok: false, error: 'httpsのURLを指定してください(localhostのみhttpも使えます)' };
  }

  const normalized = `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  return { ok: true, normalized };
}

/** 保存済みの接続先(未設定ならnull=公式ホスト・同一オリジン) */
export function getServerBaseUrl(): string | null {
  const raw = localStorage.getItem(SERVER_BASE_URL_KEY);
  return raw === null || raw === '' ? null : raw;
}

/** 保存はsettings画面の接続テスト成功時のみ呼ぶこと(未検証のURLを基底に据えない) */
export function setServerBaseUrl(url: string): void {
  localStorage.setItem(SERVER_BASE_URL_KEY, url);
}

/** 既定(公式ホスト・同一オリジン)に戻す */
export function clearServerBaseUrl(): void {
  localStorage.removeItem(SERVER_BASE_URL_KEY);
}

/**
 * 候補URLへ直接GET /api/healthを叩く(素のfetchのみ。新規依存を追加しない)。
 * 保存前の候補を試すためapiClient.apiFetchは使わない(あちらは保存済みの基底URLを読むため)。
 */
export async function testServerConnection(url: string): Promise<{ ok: true } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(`${url}/api/health`);
  } catch {
    return { ok: false, error: 'サーバーに接続できませんでした' };
  }
  if (!res.ok) {
    return { ok: false, error: `接続に失敗しました(status ${res.status})` };
  }
  const body: unknown = await res.json().catch(() => null);
  if ((body as { status?: string } | null)?.status !== 'ok') {
    return { ok: false, error: '応答の形式が想定と異なります' };
  }
  return { ok: true };
}
