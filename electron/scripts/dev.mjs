// Electron開発用の起動スクリプト。
// Vite dev serverを起動 → 応答を待つ → electron本体を起動する、の順で行う。
// concurrently/wait-on等の追加パッケージを使わず、Node標準機能のみで実装する。
import { spawn } from 'node:child_process';
import http from 'node:http';
import process from 'node:process';

// ポートはこちらから指定して固定する。Viteの既定は使用中だと別ポートへ自動で逃げるため、
// 固定しないと待ち受けURLがずれて「30秒待って諦める」という分かりにくい失敗になる。
// --strictPort を渡すことで、使用中なら即座にVite側がエラー終了し原因が分かる。
const DEV_PORT = Number(process.env.VITE_DEV_PORT ?? 5173);
const DEV_SERVER_URL = `http://localhost:${DEV_PORT}`;
const POLL_INTERVAL_MS = 300;
const POLL_TIMEOUT_MS = 30_000;

function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error(`dev serverが${timeoutMs}ms以内に応答しませんでした: ${url}`));
          return;
        }
        setTimeout(tryOnce, POLL_INTERVAL_MS);
      });
    };
    tryOnce();
  });
}

const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';
const npxCmd = isWindows ? 'npx.cmd' : 'npx';

const vite = spawn(npmCmd, ['run', 'dev', '--', '--port', String(DEV_PORT), '--strictPort'], {
  stdio: 'inherit',
  shell: false,
});

let electronProcess = null;
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (electronProcess && !electronProcess.killed) {
    electronProcess.kill();
  }
  if (vite && !vite.killed) {
    vite.kill();
  }
  process.exit(code ?? 0);
}

vite.on('exit', (code) => {
  if (!shuttingDown) shutdown(code ?? 0);
});

waitForServer(DEV_SERVER_URL, POLL_TIMEOUT_MS)
  .then(() => {
    electronProcess = spawn(npxCmd, ['electron', '.'], {
      stdio: 'inherit',
      shell: false,
      env: { ...process.env, VITE_DEV_SERVER_URL: DEV_SERVER_URL },
    });
    electronProcess.on('exit', (code) => shutdown(code ?? 0));
  })
  .catch((err) => {
    console.error(err.message);
    shutdown(1);
  });

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
