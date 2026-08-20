-- 同期データ暗号化の鍵受け渡し(#182。architecture.md §6)。
--
-- 端末が持つデータ鍵(DK)を、もう一方の端末へ渡すための一時的な置き場。
-- 8桁の受け渡しコードで包まれた暗号文とsaltだけを持ち、**DKもコードもサーバーには渡らない**。
--
-- 1アカウント1件。やり直しはUPSERTで上書きする(古い受け渡しは無効になる)。
-- 受け取り成功時にクライアントがDELETEし、取り残しはexpires_at(5分)で失効させる。
-- fetch_countは取り出し回数の上限(総当たり対策)に使う。
CREATE TABLE key_shares (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  salt TEXT NOT NULL,
  wrapped_dk TEXT NOT NULL,
  fetch_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
