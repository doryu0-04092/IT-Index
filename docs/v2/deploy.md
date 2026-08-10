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

サーバーが必要とするシークレットは **`JWT_SECRET`** と **`ANTHROPIC_API_KEY`** の2つ
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

### ANTHROPIC_API_KEY

```
npx wrangler secret put ANTHROPIC_API_KEY
```

**投入前に、Anthropicコンソールでこのキーの支出上限(スペンドリミット)を必ず設定すること。**
これは[architecture.md §6](./architecture.md#6-セキュリティ)の「支出上限」層に対応する、
防止策が全て破られた後に効く最後の防波堤であり、v1では第1層として位置づけられていた
([requirements.md §5.6](../requirements.md#56-重点セキュリティ--漏れても被害が有限を先に作る))。
サーバー側キーに一本化したv2ではこの層の重要性がさらに増す(キーが漏れれば
利用者全員の分の被害になりうるため)。設定手順:

1. Anthropic Console(console.anthropic.com)にログイン
2. 対象のAPIキーが属するワークスペース(専用ワークスペースを推奨)の使用上限(Usage limits /
   Spend limit)を設定する
3. 上限額は想定利用規模(利用者数 × `AI_DAILY_LIMIT_PER_USER` × 想定日数)から余裕を持って決める

---

## 3. 環境変数の調整(任意)

既定値で問題なければこの手順は不要(`AI_MODEL`/`AI_MAX_TOKENS`/`AI_DAILY_LIMIT_PER_USER`/
`AI_DAILY_LIMIT_GLOBAL` は未設定でもコード側の既定値で動く。[server/src/ai.ts](../../v2/server/src/ai.ts)参照)。

上書きする場合は `v2/server/wrangler.jsonc` の `vars` に追記する(シークレットではなく通常の
環境変数のため `wrangler secret put` は不要):

```jsonc
{
  // ...既存の設定...
  "vars": {
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

成功すると `https://<name>.<account>.workers.dev` の形式でURLが表示される
(`<name>` は `wrangler.jsonc` の `name`、既定は `it-index-v2-server`)。

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
- Anthropic側の支出上限(§2)は無料枠と無関係に効く。AIプロキシの回数上限
  (`AI_DAILY_LIMIT_PER_USER`/`AI_DAILY_LIMIT_GLOBAL`)を超えた場合は429エラーになり、
  Anthropic APIへのリクエスト自体が発生しないため課金もされない
