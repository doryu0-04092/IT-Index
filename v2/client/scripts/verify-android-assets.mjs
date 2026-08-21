/**
 * Androidパッケージへ入るWeb資産に、サーバーのURLが埋まっているかを検査する。
 *
 * **なぜ必要か（2026-08-22の実障害）。** Capacitor配信では画面のオリジンが端末内になるため、
 * `apiClient.ts` の既定である相対パス `/api` は端末自身を指してしまいサーバーへ届かない。
 * これを避けるため `.env.android` が `VITE_API_BASE` を渡すが、Viteは **mode に一致する
 * `.env.<mode>` しか読まない**——`npm run build:android`(`vite build --mode android`)ではなく
 * 素の `vite build` で作ると、**型検査もlintもテストも全て緑のまま**、
 * サーバーへ一切繋がらないAPKが出来上がる。実際に 0.4.3 をその状態で公開してしまった。
 *
 * 失敗が「動かすまで分からない」形なので、**パッケージへ入る直前の成果物を機械的に見る。**
 * 見るのはビルドの入力(env)ではなく出力(JS)——手順を間違えても出力には必ず現れるため。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const assetsDir = process.argv[2] ?? 'dist/assets';

let files;
try {
  files = readdirSync(assetsDir).filter((f) => f.startsWith('index-') && f.endsWith('.js'));
} catch {
  console.error(`[verify-android-assets] ${assetsDir} を読めませんでした。先にビルドしてください。`);
  process.exit(1);
}

if (files.length === 0) {
  console.error(`[verify-android-assets] ${assetsDir} に index-*.js がありません。`);
  process.exit(1);
}

// apiUrl() は `${getServerBaseUrl() ?? VITE_API_BASE ?? ''}/api${path}` の形に畳まれる。
// VITE_API_BASE が未定義だと、この位置が `void 0` になる（= 相対パスへ落ちる）。
const BROKEN = /\?\?\s*void 0\s*\?\?\s*(``|""|'')\s*\}?\/api/;
const OK = /\?\?\s*(`|"|')https?:\/\/[^`"']+\1\s*\?\?/;

for (const file of files) {
  const source = readFileSync(join(assetsDir, file), 'utf8');
  if (!source.includes('/api')) continue;

  if (BROKEN.test(source)) {
    console.error(
      `[verify-android-assets] ${file}: VITE_API_BASE が埋まっていません。\n` +
        `  サーバーへ繋がらないAPKになります。\n` +
        `  'npm run build' ではなく 'npm run build:android' を使ってください` +
        `（Viteは --mode android の時だけ .env.android を読みます）。`
    );
    process.exit(1);
  }

  if (OK.test(source)) {
    console.log(`[verify-android-assets] ${file}: サーバーURLが埋まっています。OK`);
    process.exit(0);
  }
}

console.error(
  '[verify-android-assets] apiUrl() の基底URLを判定できませんでした。' +
    'apiClient.ts の形が変わった場合はこの検査も更新してください。'
);
process.exit(1);
