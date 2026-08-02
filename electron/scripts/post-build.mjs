// ルートの package.json が "type": "module" のため、dist-electron/*.js も既定では
// ESM として解釈される。electron 本体は CommonJS モジュールで名前付き import ができず、
// sandbox:true の preload も CommonJS でなければ読み込めないため、出力側に
// package.json を置いて「ここは CommonJS」と明示する。
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../dist-electron');
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'package.json'), `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);
console.log('dist-electron/package.json を書き出しました（type: commonjs）');
