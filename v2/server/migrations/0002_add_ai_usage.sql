-- architecture.md §5: AIプロキシは利用者別回数上限を必須で持つ。会話内容は保存しない
-- ため、このテーブルは回数(count)のみを持つ。全体上限はaccount_id='__global__'の行で
-- カウントする(実在するアカウントIDとは衝突しない予約値)。

CREATE TABLE ai_usage (
  account_id TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (account_id, day)
);
