-- architecture.md §3: ライセンスは「発行(issue)」と「有効化(activate)」を分離する。
-- 発行時点では account_id・activated_at は空(=在庫。決済モックの「発行」に対応)で、
-- 利用者がコードを入力した時点で両方を埋める。code の PRIMARY KEY(=UNIQUE) と
-- activated_at の有無だけで「1コード=1回の有効化」を検証できるようにするため、
-- accounts の列(has_license 等)ではなく別テーブルにしている。
-- このテーブルが意味を持つのは公式ホスト運用時のみ(セルフホストは LICENSE_ENABLED='0')。

CREATE TABLE licenses (
  code TEXT PRIMARY KEY,
  -- 未有効化(在庫)の間はNULL。有効化したアカウントを1件だけ持つ。
  account_id TEXT REFERENCES accounts(id),
  -- 'purchase'=決済モック経由で発行 / 'operator'=運営者が手動発行(検証・優待用)。
  source TEXT NOT NULL CHECK (source IN ('purchase', 'operator')),
  issued_at INTEGER NOT NULL,
  activated_at INTEGER
);

-- ライセンスゲート(sync/push・sync/pull・運営者キーのAIチャット)は
-- 「このアカウントに有効化済みの行があるか」を毎リクエスト引くため、account_id に索引を置く。
CREATE INDEX idx_licenses_account_id ON licenses(account_id);
