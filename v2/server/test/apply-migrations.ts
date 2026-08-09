import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// setupファイルはテストファイル単位の分離ストレージの外側で複数回実行されうるが、
// applyD1Migrations()は未適用のマイグレーションだけを当てるため、ここで呼んで安全。
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
