// lp/ を v2/client/dist/lp/ へコピーして、公式ホストの /lp/ で配信できるようにする(#155)。
//
// Workerの静的アセット配信(v2/server/wrangler.jsonc assets.directory=../client/dist)は
// 実在するファイルを最優先で返し、SPAフォールバックは不存在時のみのため、
// dist/lp/ に置くだけで https://<公式ホスト>/lp/ がWebページとして表示される。
//
// リリース添付用の単一ファイル版(build-standalone.mjs)とは役割が別:
// - こちら: Web配信用。画像は別ファイルのまま(ブラウザキャッシュが効く)
// - あちら: 配布ファイル用。画像をdata URI化した1ファイル
//
// 使い方: node lp/copy-to-dist.mjs (v2のdeployスクリプトがビルド後に呼ぶ)

import { cp, mkdir, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LP_DIR = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(LP_DIR, '../v2/client/dist');
const OUT = resolve(DIST, 'lp');

// clientのビルドが先に済んでいることを確認する。無い状態で作ると
// 「LPだけのdist」ができてしまい、次のwrangler deployでアプリが消える。
await access(resolve(DIST, 'index.html')).catch(() => {
  throw new Error(`clientのビルド成果物がありません: ${DIST}\n先に vite build (npm run build -w client) を実行してください`);
});

await mkdir(OUT, { recursive: true });
await cp(resolve(LP_DIR, 'index.html'), resolve(OUT, 'index.html'));
await cp(resolve(LP_DIR, 'assets'), resolve(OUT, 'assets'), { recursive: true });

console.log(`コピー完了: ${OUT} (index.html + assets/)`);
