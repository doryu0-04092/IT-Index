// architecture.md §2: サーバー(リレー)は端末別差分の中継と保管のみを責務とする。
// architecture.md §5: AIプロキシはサーバー側キーを保持し、回数上限を必須で持つ。
// AI_*系は未設定でも動くよう文字列で受けてparseし、既定値をコード側に持つ(ai.ts参照)。
export type Env = {
  DB: D1Database;
  JWT_SECRET: string;
  ANTHROPIC_API_KEY: string;
  AI_MODEL?: string;
  AI_MAX_TOKENS?: string;
  AI_DAILY_LIMIT_PER_USER?: string;
  AI_DAILY_LIMIT_GLOBAL?: string;
};
