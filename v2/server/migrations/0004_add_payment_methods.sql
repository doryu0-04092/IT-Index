-- お支払い方法の表示情報と解約(architecture.md §3 / requirements.md §4.2)。
--
-- 元は端末のlocalStorageにだけ置いていたが、ライセンスの有効/無効はアカウント単位
-- (licensesテーブル)で持つため、購入した端末以外では「ライセンス有効なのにカード未登録」
-- という矛盾した表示になっていた。有償機能が端末間同期である以上、複数端末の利用者ほど
-- 必ずこの状態に当たるため、表示情報もアカウントに属するデータとしてここへ移す。
--
-- **完全なカード番号とCVCの列は存在しない**。保持するのは画面に出す4項目だけで、
-- モックであっても実カード情報は端末にもサーバーにも残さない方針は変えていない。

CREATE TABLE payment_methods (
  -- 1アカウント1枚。カード変更はUPSERTでこの行を上書きする。
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  brand TEXT NOT NULL,
  -- カード番号の下4桁のみ。
  last4 TEXT NOT NULL,
  -- "MM/YY"
  expiry TEXT NOT NULL,
  holder_name TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 解約(即時無効)。行は削除せずcanceled_atを立てる: codeのPRIMARY KEYと合わせて
-- 「1コード=1回の有効化」を保ったまま、解約済みであることを記録に残すため
-- (解約したコードで再有効化できてしまわない)。再開は新規購入=新しいコードの発行になる。
ALTER TABLE licenses ADD COLUMN canceled_at INTEGER;
