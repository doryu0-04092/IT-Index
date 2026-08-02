import http from 'node:http';
import os from 'node:os';
import type { Socket } from 'node:net';

/**
 * ローカルHTTPサーバー（メインプロセス側）。
 * Node標準の http モジュールのみを使う（新規依存を増やさない）。
 *
 * 契約:
 * - ルートは POST /sync の1本だけ。それ以外は404。
 * - 1セッションにつき1回だけ受け付け、処理後は自動でサーバーを閉じる。
 * - 誰も来なければ SESSION_TIMEOUT_MS で自動的に閉じる。
 * - respond() が呼ばれない場合に備え、応答待ちにも RESPONSE_TIMEOUT_MS のタイムアウトを設ける。
 * - ボディは MAX_BODY_BYTES を超えたら 413 で切る。
 * - 停止時はソケットを確実に閉じる。
 */

const PREFERRED_PORT = 17321;
const PORT_FALLBACK_ATTEMPTS = 10;
const MAX_BODY_BYTES = 32 * 1024 * 1024; // 32MB
const SESSION_TIMEOUT_MS = 120_000; // 2分間、誰も接続してこなければ閉じる
const RESPONSE_TIMEOUT_MS = 30_000; // レンダラーからの応答待ちタイムアウト

export type PairingRequestHandler = (requestId: string, body: string) => void;

export interface PairingStartResult {
  url: string | null;
  reason?: string;
}

interface PendingResponse {
  res: http.ServerResponse;
  timer: NodeJS.Timeout;
}

export class PairingServer {
  private server: http.Server | null = null;
  private readonly sockets = new Set<Socket>();
  private sessionTimer: NodeJS.Timeout | null = null;
  private readonly pending = new Map<string, PendingResponse>();
  private requestHandler: PairingRequestHandler | null = null;
  private requestCounter = 0;
  private handled = false;

  /** POST /sync を受信した時に呼ばれるハンドラを設定する。 */
  setRequestHandler(handler: PairingRequestHandler | null): void {
    this.requestHandler = handler;
  }

  async start(): Promise<PairingStartResult> {
    // 多重起動防止: 既に動いていれば一度止めてから起動し直す
    if (this.server) {
      await this.stop();
    }

    const lanAddress = pickLanAddress();
    if (!lanAddress) {
      return {
        url: null,
        reason: 'LAN内で到達可能なIPv4アドレスが見つかりませんでした。Wi-Fi/LAN接続を確認してください。',
      };
    }

    this.handled = false;

    const server = http.createServer((req, res) => this.handleRequest(req, res));
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });

    const port = await listenWithFallback(server, PREFERRED_PORT, PORT_FALLBACK_ATTEMPTS);
    if (port === null) {
      return {
        url: null,
        reason: `ポート${PREFERRED_PORT}付近が使用中のため、サーバーを起動できませんでした。`,
      };
    }

    this.server = server;
    this.sessionTimer = setTimeout(() => {
      void this.stop();
    }, SESSION_TIMEOUT_MS);

    return { url: `http://${lanAddress}:${port}` };
  }

  /** サーバーを停止する。二重呼び出しでも失敗しない。 */
  async stop(): Promise<void> {
    if (this.sessionTimer) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = null;
    }

    // 応答待ちのリクエストがあれば、ソケットを壊す前にエラー応答を確実に流し切る
    const pendingEntries = [...this.pending.values()];
    this.pending.clear();
    await Promise.all(
      pendingEntries.map(
        ({ res, timer }) =>
          new Promise<void>((resolve) => {
            clearTimeout(timer);
            if (res.writableEnded) {
              resolve();
              return;
            }
            res.end('Service Unavailable', () => resolve());
          })
      )
    );

    const server = this.server;
    this.server = null;
    if (!server) return;

    // 待機中の接続が残ってプロセスが終了できなくなるのを防ぐため、確実に閉じる
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  /** onPairingRequest への応答。body が null ならエラー応答（HTTP 400）を返す。 */
  async respond(requestId: string, body: string | null): Promise<void> {
    const pending = this.pending.get(requestId);
    if (!pending) return; // 既にタイムアウト済み・不明なIDは無視
    this.pending.delete(requestId);
    clearTimeout(pending.timer);

    await new Promise<void>((resolve) => {
      if (body === null) {
        pending.res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        pending.res.end('Bad Request', () => resolve());
      } else {
        pending.res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        pending.res.end(body, () => resolve());
      }
    });

    // 1セッション1回のみ。応答を返したら自動でサーバーを閉じる
    await this.stop();
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    if (req.method !== 'POST' || req.url !== '/sync') {
      res.writeHead(404).end();
      return;
    }

    if (this.handled) {
      res.writeHead(409, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Already handled');
      return;
    }
    this.handled = true;

    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;

    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Payload Too Large', () => {
          void this.stop();
        });
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) return;
      const body = Buffer.concat(chunks).toString('utf-8');
      const requestId = `req-${Date.now()}-${++this.requestCounter}`;

      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        if (!res.writableEnded) {
          res.writeHead(504, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Gateway Timeout', () => {
            void this.stop();
          });
        } else {
          void this.stop();
        }
      }, RESPONSE_TIMEOUT_MS);

      this.pending.set(requestId, { res, timer });

      if (this.requestHandler) {
        this.requestHandler(requestId, body);
      } else {
        // レンダラー側が準備できていない
        this.pending.delete(requestId);
        clearTimeout(timer);
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Service Unavailable', () => {
          void this.stop();
        });
      }
    });

    req.on('error', () => {
      aborted = true;
    });
  }
}

function listenWithFallback(server: http.Server, startPort: number, attempts: number): Promise<number | null> {
  return new Promise((resolve) => {
    let attempt = 0;

    const tryListen = (port: number) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE' && attempt < attempts) {
          attempt += 1;
          tryListen(port + 1);
        } else {
          resolve(null);
        }
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '0.0.0.0');
    };

    tryListen(startPort);
  });
}

function pickLanAddress(): string | null {
  const interfaces = os.networkInterfaces();
  const candidates: string[] = [];

  for (const infos of Object.values(interfaces)) {
    if (!infos) continue;
    for (const info of infos) {
      if (info.family === 'IPv4' && !info.internal) {
        candidates.push(info.address);
      }
    }
  }

  if (candidates.length === 0) return null;

  const privateCandidates = candidates.filter(isPrivateAddress);
  return privateCandidates[0] ?? candidates[0];
}

function isPrivateAddress(addr: string): boolean {
  if (addr.startsWith('192.168.')) return true;
  if (addr.startsWith('10.')) return true;
  const parts = addr.split('.');
  if (parts[0] === '172') {
    const second = Number(parts[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}
