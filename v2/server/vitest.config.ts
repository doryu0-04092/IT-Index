import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// @cloudflare/vitest-pool-workers v0.20系はvitest ^4.1.0が要件(peerDependencies)。
// v2ルートのvitestは^4.1.10で満たすため、専用のvitestバージョンは持たず
// ルートのvitestをそのまま使う(v2/vitest.config.tsのprojectsから束ねられる)。
export default defineConfig(async () => {
  // Windowsではfile URLの.pathnameがドライブ文字の前に余分な"/"を残すため、
  // fileURLToPath相当のpath.join(import.meta.dirname, ...)で組み立てる。
  const migrationsPath = path.join(import.meta.dirname, 'migrations');
  const migrations = await readD1Migrations(migrationsPath);

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          // テスト専用バインディング。マイグレーションをsetupファイルへ渡すためだけに使う。
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
    },
  };
});
