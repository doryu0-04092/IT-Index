// architecture.md §2: サーバー(リレー)は端末別差分の中継と保管のみを責務とする。
// architecture.md §5: AIプロキシはサーバー側キーを保持し、回数上限を必須で持つ。
// AI_*系は未設定でも動くよう文字列で受けてparseし、既定値をコード側に持つ(ai.ts参照)。
// AI_PROVIDERでAnthropic/OpenAIを切り替える(未設定時はコード既定の'anthropic'=後方互換)。
// ANTHROPIC_API_KEY/OPENAI_API_KEYはどちらも型上は必須にしない(openai運用時はANTHROPIC_API_KEY
// が無くても起動できるようにするため)。使う瞬間に無ければai_config_errorにする(providers/*.ts参照)。
// CORS_ALLOWED_ORIGINはローカル開発専用(vite:5173→wrangler:8787)。本番は同一オリジン配信のため未設定のまま。
export type Env = {
  DB: D1Database;
  JWT_SECRET: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  AI_PROVIDER?: 'anthropic' | 'openai';
  AI_MODEL?: string;
  AI_MAX_TOKENS?: string;
  AI_DAILY_LIMIT_PER_USER?: string;
  AI_DAILY_LIMIT_GLOBAL?: string;
  CORS_ALLOWED_ORIGIN?: string;
};
