// lp/index.html を「1ファイルで完結するHTML」に変換する。
//
// なぜ必要か: index.html は assets/*.png を相対パスで参照しているため、HTMLだけを
// 配布すると画像が全て壊れる。GitHubリリースの添付ファイルはファイル単位でしか
// 配れないので、画像を data URI に埋め込んで自己完結させる。
//
// 出典は lp/index.html と lp/assets/ のみ。生成物は dist/ 配下（.gitignore対象）に
// 置き、コミットしない。LPを直せば生成物も自動的に追従する（二重管理を作らない）。
//
// 使い方: node lp/build-standalone.mjs

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LP_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(LP_DIR, 'index.html');
const OUT_DIR = resolve(LP_DIR, 'dist');
const OUT_FILE = resolve(OUT_DIR, 'it-index-start.html');

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

/**
 * assets/ を参照する src 属性を data URI に置き換える。
 * @param {string} html 変換元のHTML
 * @returns {Promise<{html: string, inlined: string[]}>} 変換後のHTMLと埋め込んだファイルの一覧
 */
async function inlineAssets(html) {
  const inlined = [];
  const refs = [...new Set([...html.matchAll(/src="(assets\/[^"]+)"/g)].map((m) => m[1]))];

  let out = html;
  for (const ref of refs) {
    const ext = ref.slice(ref.lastIndexOf('.')).toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (!mime) {
      throw new Error(`未対応の拡張子です: ${ref}（MIME_BY_EXT に追加してください）`);
    }
    const bytes = await readFile(resolve(LP_DIR, ref));
    const dataUri = `data:${mime};base64,${bytes.toString('base64')}`;
    out = out.replaceAll(`src="${ref}"`, `src="${dataUri}"`);
    inlined.push(`${ref} (${(bytes.length / 1024).toFixed(0)} KB)`);
  }
  return { html: out, inlined };
}

/**
 * 外部ファイルへの相対参照が残っていないか検査する。
 * 残ったまま配布すると、利用者の手元でリンク切れ・画像欠けとして初めて露見するため、
 * 生成時点で失敗させる。
 * @param {string} html 検査対象のHTML
 * @returns {string[]} 相対参照とみなした属性値の一覧（空なら自己完結）
 */
function findExternalRefs(html) {
  const values = [...html.matchAll(/(?:src|href)="([^"]*)"/g)].map((m) => m[1]);
  return values.filter((v) => !/^(https?:|data:|mailto:|#)/.test(v));
}

const source = await readFile(SOURCE, 'utf8');
const { html, inlined } = await inlineAssets(source);

const leftovers = findExternalRefs(html);
if (leftovers.length > 0) {
  throw new Error(`自己完結していません。相対参照が残っています:\n  ${leftovers.join('\n  ')}`);
}

await mkdir(OUT_DIR, { recursive: true });
await writeFile(OUT_FILE, html, 'utf8');

console.log(`埋め込み: ${inlined.length}件`);
for (const item of inlined) console.log(`  - ${item}`);
console.log(`出力: ${OUT_FILE} (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB)`);
