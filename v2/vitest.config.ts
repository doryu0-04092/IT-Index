import { defineConfig } from 'vitest/config';

// shared(node環境)・client(jsdom環境)・server(Cloudflare Workers環境)をプロジェクトとして束ね、
// v2ルートの `npm run test` 1回で全部を実行する。
// server配下は @cloudflare/vitest-pool-workers 独自のプール設定を持つ vitest.config.ts を
// 自前で読み込むため、ここではディレクトリを指すだけで良い(vitest workspaceの標準的な使い方)。
export default defineConfig({
  test: {
    projects: ['shared', 'client', 'server'],
    /**
     * カバレッジ計測(#171)。同期関連のロジック層に限定して計測する——UIコンポーネントの
     * 全分岐100%は防御コストに見合わないため対象に含めない(#171の合意事項)。
     * `npm run coverage` から使う。計測専用でアプリの動作には影響しない。
     */
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: [
        'shared/src/core/mergeSnapshot.ts',
        'shared/src/core/validateSyncFile.ts',
        'shared/src/core/syncTarget.ts',
        'client/src/sync/syncEngine.ts',
        'client/src/sync/localSnapshot.ts',
        'client/src/sync/pendingPush.ts',
        'client/src/sync/useConflictResolution.ts',
        'client/src/repositories/noteConflicts.ts',
        'client/src/repositories/syncEvents.ts',
        'client/src/repositories/syncState.ts',
        'client/src/repositories/notes.ts',
      ],
    },
  },
});
