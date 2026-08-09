// architecture.md §2: サーバー(リレー)は端末別差分の中継と保管のみを責務とする。
// ここで持つバインディングもそれに合わせて最小限(D1と認証シークレットのみ)。
export type Env = {
  DB: D1Database;
  JWT_SECRET: string;
};
