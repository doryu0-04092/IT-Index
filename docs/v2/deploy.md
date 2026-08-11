# IT-Index v2 デプロイ手順 — Cloudflare Workers + D1

- 版: 0.1(2026-08-10。初版)
- 前提: [v2 アーキテクチャ](./architecture.md) §7(サーバー基盤の選定結果: Cloudflare Workers + D1)
- 対象: `v2/server`(Hono + D1 + 静的アセット配信)。`v2/client` のビルド結果(`v2/client/dist`)を
  同一Workerから同一オリジンで配信する構成(APIは相対パス`/api/*`のまま動く)。

このドキュメントは手順書であり、実際のデプロイ(`wrangler login`・`wrangler secret put`・
アカウント作成)はここでは行わない。実行する場合は本人の判断で進める。

---

## 0. 前提

1. Cloudflareアカウントを作成する(無料枠で開始できる。**クレジットカード登録の要否はアカウント作成画面で確認すること** — [architecture.md §7](./architecture.md)の時点では未確認事項として残っている)
2. `v2/server` で認証する

   ```
   cd v2/server
   npx wrangler login
   ```

   ブラウザが開き、Cloudflareアカウントへの認可を求められる。

---

## 1. D1データベースの作成

```
cd v2/server
npx wrangler d1 create it-index-v2
```

出力に `database_id` が表示される。これを **`v2/server/wrangler.jsonc` の
`d1_databases[0].database_id`**(現在はテスト・ローカル開発用のプレースホルダ
`00000000-0000-0000-0000-000000000000` が入っている行)へ書き換える。

書き換えたら、マイグレーションをリモートD1へ適用する。

```
cd v2
npm run deploy:migrations
```

内部では `wrangler d1 migrations apply it-index-v2 --remote -c wrangler.jsonc` が
`v2/server` 上で実行され、`v2/server/migrations/0001_init.sql` と
`0002_add_ai_usage.sql` がリモートに適用される。実行前に適用予定のマイグレーション一覧が
表示され、確認を求められる(CI等の非対話環境では確認をスキップしてバックアップのみ取得される)。

---

## 2. シークレットの投入

サーバーが必要とするシークレットは **`JWT_SECRET`** と、AI_PROVIDER([server/wrangler.jsonc](../../v2/server/wrangler.jsonc)の
`vars.AI_PROVIDER`。既定は本番運用の`openai`)に応じて **`OPENAI_API_KEY`** または
**`ANTHROPIC_API_KEY`** のいずれか
([server/src/types.ts](../../v2/server/src/types.ts) の `Env` 型参照)。

### JWT_SECRET

ランダムな32文字以上の文字列を生成して使う。生成例(どちらでもよい):

```
# PowerShell
-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 40 | ForEach-Object {[char]$_})

# Bash / macOS / Linux
openssl rand -base64 32
```

```
npx wrangler secret put JWT_SECRET
```

プロンプトが出たら生成した文字列を貼り付ける。

### OPENAI_API_KEY(本番運用。`AI_PROVIDER=openai`の場合)

**投入前に、platform.openai.comの Settings → Limits で月次支出上限を必ず設定すること。**
これは[architecture.md §6](./architecture.md#6-セキュリティ)の「支出上限」層に対応する、
防止策が全て破られた後に効く最後の防波堤であり、v1では第1層として位置づけられていた
([requirements.md §5.6](../requirements.md#56-重点セキュリティ--漏れても被害が有限を先に作る))。
サーバー側キーに一本化したv2ではこの層の重要性がさらに増す(キーが漏れれば
利用者全員の分の被害になりうるため)。設定手順:

1. platform.openai.com にログイン
2. Settings → Limits で月次支出上限(Monthly budget)を設定する
3. 上限額は想定利用規模(利用者数 × `AI_DAILY_LIMIT_PER_USER` × 想定日数)から余裕を持って決める

上限を設定したら、キーを投入する。

```
npx wrangler secret put OPENAI_API_KEY
```

### ANTHROPIC_API_KEY(`AI_PROVIDER=anthropic`に切り替える場合のみ必要)

`AI_PROVIDER=openai`で運用する限り、このキーは不要(未設定でも起動できる)。
Anthropic運用に切り替える場合のみ、Anthropicコンソール(console.anthropic.com)で
対象のAPIキーが属するワークスペースの使用上限(Usage limits / Spend limit)を先に設定してから
投入する。

```
npx wrangler secret put ANTHROPIC_API_KEY
```

---

## 3. 環境変数の調整(任意)

`v2/server/wrangler.jsonc` の `vars` に、本番運用の既定として
`AI_PROVIDER: "openai"` / `AI_MODEL: "gpt-5.6-luna"` が既に設定されている
([server/src/providers/openai.ts](../../v2/server/src/providers/openai.ts)参照)。
`AI_MAX_TOKENS`/`AI_DAILY_LIMIT_PER_USER`/`AI_DAILY_LIMIT_GLOBAL` は未設定でも
コード側の既定値で動く([server/src/providers](../../v2/server/src/providers)配下参照)。

Anthropic運用に切り替える、または既定値を上書きする場合は `v2/server/wrangler.jsonc` の
`vars` を編集する(シークレットではなく通常の環境変数のため `wrangler secret put` は不要):

```jsonc
{
  // ...既存の設定...
  "vars": {
    "AI_PROVIDER": "anthropic",
    "AI_MODEL": "claude-sonnet-5",
    "AI_MAX_TOKENS": "4096",
    "AI_DAILY_LIMIT_PER_USER": "50",
    "AI_DAILY_LIMIT_GLOBAL": "500"
  }
}
```

`CORS_ALLOWED_ORIGIN` は本番では設定しないこと(クライアントとAPIを同一オリジンから配信するため
不要。設定するとCORSヘッダが付き、意図しないオリジンからの呼び出しを許可する側に倒すリスクが
無意味に増える)。ローカル開発でvite dev(5173)からwrangler dev(8787)を直接叩く場合のみ
`v2/server/.dev.vars` に設定する([.dev.vars.example](../../v2/server/.dev.vars.example)参照)。

---

## 4. デプロイ

```
cd v2
npm run deploy
```

内部では `npm run build -w client`(`v2/client/dist` を生成) → `npm run deploy -w server`
(`wrangler deploy`。`v2/server/wrangler.jsonc` の `assets.directory` が
`../client/dist` を指しているため、同じWorkerが `/api/*` はHonoアプリで処理し、それ以外は
静的アセットとして配信する)の順で実行される。

成功すると `https://<name>.<subdomain>.workers.dev` の形式でURLが表示される。
`<name>` は `wrangler.jsonc` の `name`(現在は `it-index`)、`<subdomain>` はアカウントに
登録したworkers.devサブドメイン。**初回はこのURLが未有効なため、ダッシュボードで有効化する**:

1. [Workers & Pages](https://dash.cloudflare.com/) → 対象のWorker → **ドメイン**タブ
2. **Worker URL** 枠の「プロダクション」行のトグルをONにする
   (「カスタムドメインとルーティングする」は独自ドメイン用なので触らない)

`name` を変更すると**別のWorkerとして作られる**ため、シークレットの再投入とこの有効化を
やり直す必要がある(旧Workerは `npx wrangler delete --name <旧name>` で削除する)。

---

## 5. デプロイ後の疎通チェックリスト

上から順に確認する。途中で失敗した場合、それより後は意味を持たないため一旦止めて調査する。

- [ ] `GET /api/health` が `200 { "status": "ok" }` を返す
- [ ] デプロイ先URLをブラウザで開き、画面が表示される(単一UIが描画される)
- [ ] 新規アカウントでsignupできる
- [ ] signupしたアカウントでlogin・ログアウト・再loginができる
- [ ] 2台の端末(またはブラウザの別プロファイル/シークレットウィンドウ)で同じアカウントに
      login し、片方で作成したデータがpush → もう片方でpullして反映される(同期の往復)
- [ ] **AIチャットを実際のAPIキーで1回実行し、応答が返る**
      (v1では実キーでの疎通確認が最後まで行われなかった経緯があるため、
      ここは省略せず必ず実施する)
      - **PowerShellから直接APIを叩いて確認する場合は文字コードに注意**。
        `Invoke-RestMethod -Body <文字列>` はcharset未指定だと日本語をUTF-8で送らないため、
        壊れた日本語がモデルへ届き「日本語で聞いたのに中国語で返る」ように見える
        (2026-08-10の検証で実際に誤判定した)。`[System.Text.Encoding]::UTF8.GetBytes($json)`
        でバイト送信し、応答も `GetEncoding(28591)` → UTF-8 で読み直すこと。
        ブラウザから画面越しに確認する場合はこの問題は起きない。
- [ ] `GET /api/ai/quota` が使用回数と上限を返す(AIチャット実行後に `used` が増えていること)
- [ ] (任意)上限に達するまで呼び出し、`429 ai_limit_exceeded` が返ることを確認する

---

## 6. 運用メモ

- **無料枠を超えても課金は発生しない。エラーになるだけ。**
  ([architecture.md §7](./architecture.md#7-サーバー基盤の選定基準と選定結果)で確認済みの
  Cloudflareの仕様)。具体的な枠(API 10万件/日・D1書込10万行/日・D1容量5GB)は
  [Cloudflareダッシュボード](https://dash.cloudflare.com/)の該当プロジェクトの
  Workers / D1 それぞれの使用量画面、または
  [Cloudflare公式の料金ページ](https://developers.cloudflare.com/workers/platform/pricing/)で
  最新の数値を確認する(無料枠の数値は変更されうるため、このドキュメントの数値を鵜呑みにせず
  都度確認すること)
- AIプロバイダ側の支出上限(§2)は無料枠と無関係に効く。AIプロキシの回数上限
  (`AI_DAILY_LIMIT_PER_USER`/`AI_DAILY_LIMIT_GLOBAL`)を超えた場合は429エラーになり、
  上流(OpenAIまたはAnthropic)へのリクエスト自体が発生しないため課金もされない
