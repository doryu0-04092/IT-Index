-- 最小アカウント認証+同期リレー(architecture.md §3データモデル)。
-- サーバーはsync_blobsのpayloadの中身を解釈しない(マージしない=責任分離の要)。

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE sync_blobs (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  seq INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, seq)
);
