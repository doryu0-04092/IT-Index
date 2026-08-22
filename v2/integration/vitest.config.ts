import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * 結合テスト(#230)。**クライアントの同期エンジンを、実サーバー相手に動かす。**
 *
 * これまで同期は「クライアントはサーバーの模型を、サーバーはクライアントの模型を」相手に
 * テストしていて、両者を繋いだ検証が1つも無かった。しかも模型は実サーバーとずれていた
 * (`latest` が `blobs.length` / `MAX(seq)`、#202の圧縮が模型に無い)。
 *
 * **workerd の中でクライアント側も動かす。** fake-indexeddb・Dexie・crypto.subtle が
 * workerd で動くことを実測で確認したため、`wrangler dev` を別プロセスで立てる必要が無い。
 * サーバーは `SELF.fetch` で実物を叩く(server/test と同じ流儀)。
 */
export default defineConfig(async () => {
  const migrationsPath = path.join(import.meta.dirname, '..', 'server', 'migrations');
  const migrations = await readD1Migrations(migrationsPath);

  return {
    plugins: [
      cloudflareTest({
        // 実サーバーの設定をそのまま使う(バインディング名・D1の形を本物に合わせる)
        wrangler: { configPath: '../server/wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            JWT_SECRET: 'test-only-secret',
            /**
             * ライセンス確認を止める(セルフホスト相当)。
             * 公式ホストは同期に有効なライセンスを要求するが、ここで確かめたいのは
             * 同期そのものの成立であって課金導線ではない。
             * ライセンスゲート自体は server/test/license.test.ts が実物で見ている。
             */
            LICENSE_ENABLED: '0',
            // AIプロキシは本テストでは使わない。上流へ出ないようダミーを入れておく
            AI_PROVIDER: 'anthropic',
            ANTHROPIC_API_KEY: 'test-only-anthropic-key',
            AI_MODEL: 'claude-sonnet-5',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['../server/test/apply-migrations.ts', './setup.ts'],
    },
  };
});
