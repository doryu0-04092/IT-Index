import http from 'node:http';

/**
 * 読み取り役として、相手の待ち受けサーバーへ封筒をPOSTする。
 *
 * レンダラーから直接 fetch しないのは、index.html の CSP `connect-src 'self'` が
 * LAN内アドレスへの接続を遮断するため。CSPを緩めるとPC版全体の防御が下がるので、
 * 代わりにメインプロセスから送る（Android側が CapacitorHttp でネイティブ送信して
 * 同じ制約を回避しているのと同じ考え方）。
 */

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024; // 32MB。待ち受け側の上限と揃える

/**
 * HTTPステータス由来の失敗は `status` をそのまま返し、日本語化はレンダラー側
 * （src/pairing/syncStatus.ts）に任せる。文言をメインプロセスとレンダラーの2箇所に
 * 分けて持つと、片方だけ直されて食い違うため。
 */
export type PostPairingResult =
  | { ok: true; body: string }
  | { ok: false; kind: 'transport'; reason: string }
  | { ok: false; kind: 'status'; status: number };

/**
 * 接続先をプライベートアドレスに限定する。
 *
 * レンダラー側（src/pairing/pairingCodec.ts）でも同じ検証をしているが、**ここでも必ず行う**。
 * メインプロセスはCSPの外側にいるため、ここが破られると悪意あるQR1枚で任意の外部サーバーへ
 * 全スナップショットを送信させられる。二重に防ぐ。
 */
function isPrivateHost(hostname: string): boolean {
  if (hostname === '::1') return true;

  const octets = hostname.split('.');
  if (octets.length !== 4) return false;

  const nums = octets.map((o) => (/^\d{1,3}$/.test(o) ? Number(o) : Number.NaN));
  if (nums.some((n) => Number.isNaN(n) || n > 255)) return false;

  const [a, b] = nums;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

export function postPairing(url: string, body: string): Promise<PostPairingResult> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return Promise.resolve({ ok: false, kind: 'transport', reason: '接続先の形式が正しくありません。' });
  }

  if (target.protocol !== 'http:' || !target.port || !isPrivateHost(target.hostname)) {
    return Promise.resolve({
      ok: false,
      kind: 'transport',
      reason: '同じネットワーク内の端末以外へは接続しません。QRコードを確認してください。',
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: PostPairingResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const payload = Buffer.from(body, 'utf8');
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: '/sync',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': payload.byteLength },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > MAX_RESPONSE_BYTES) {
            req.destroy();
            finish({ ok: false, kind: 'transport', reason: '相手から返ってきたデータが大きすぎます。' });
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          // HTTPステータスを必ず見る。見ないと 409/413/504 の本文をそのまま復号にかけて
          // 「鍵が合いません」という無関係な案内になり、利用者がQRを読み直しても直らない。
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            finish({ ok: true, body: text });
            return;
          }
          finish({ ok: false, kind: 'status', status: res.statusCode ?? 0 });
        });
        res.on('error', () =>
          finish({ ok: false, kind: 'transport', reason: '通信が途中で切れました。もう一度お試しください。' })
        );
      }
    );

    req.on('timeout', () => {
      req.destroy();
      finish({
        ok: false,
        kind: 'transport',
        reason: '相手の端末から応答がありませんでした。もう一度お試しください。',
      });
    });
    req.on('error', () =>
      finish({
        ok: false,
        kind: 'transport',
        reason: '接続できませんでした。相手の端末が同じWi-Fiに繋がっていて、QRを表示したままか確認してください。',
      })
    );

    req.end(payload);
  });
}
