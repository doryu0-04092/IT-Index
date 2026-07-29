# Drive同期クライアント設計

- 版: 1.1（2026-07-27）
- 前提: [要件定義書](./requirements.md) §5.5 / [アーキテクチャ](./architecture.md) §4.2 / [データ層設計](./data-layer.md)

> **⚠️ 休眠中（2026-07-27）**: 同期の主手段は[手動ファイル書き出し](./manual-sync.md)に切り替えた（Google Cloud側の運用負荷を理由とする方針転換。要件定義書§5.5参照）。本文書のコードは削除せず残してあり、Google Cloud設定が済めばいつでも有効化できる。決定的マージ・同期ファイル形式などの共通ロジックは `src/sync/` に集約され、[manual-sync.md](./manual-sync.md) とも共有している。

## 0. この文書の目的

architecture.md §4.2 のシーケンス図・同期ファイル構造を、実装レベル（コードの構成・関数契約）に落とす。`mergeSnapshot()`（純関数、決定的マージ）は既に実装済みで、本文書が扱うのは**それを実際に呼び出す層**（Drive APIとの疎通・OAuth・ファイルの読み書き）。

---

## 1. 全体構成

```
src/sync/            輸送手段に依存しない共通ロジック（手動同期と共有。詳細はmanual-sync.md）
  localSnapshot.ts     … buildLocalSnapshot()
  syncFile.ts          … buildOutboundSyncFile() / syncFileName()
  resolveConflict.ts   … AI競合解決

src/drive/            Drive固有の輸送層
  config.ts      … VITE_GOOGLE_CLIENT_ID を読む（未設定なら null）
  oauth.ts       … Google Identity Services のトークンクライアント（ブラウザ専用、テスト対象外）
  driveApi.ts    … appDataFolder への REST v3 ラッパー（ブラウザ専用、テスト対象外）
  sync.ts        … runSync()（一覧取得・ダウンロード・mergeSnapshot呼び出し・アップロードのオーケストレーション）
```

`oauth.ts` と `driveApi.ts` は実際の認可・ネットワークが要るため単体テストの対象外（`src/keystore/webauthn.ts` と同じ位置づけ）。`sync.ts` はどちらもインターフェース越しに使うだけなので、フェイク実装（`src/drive/testSupport.ts`）を注入してテストする。`src/sync/` 配下は輸送手段に依存しないためDOM非依存で、そのままテストできる。

---

## 2. OAuth（`oauth.ts`）

- Google Identity Services（GIS）の `google.accounts.oauth2.initTokenClient` を使う。自前サーバーを持たない前提のため、ブラウザだけで完結するトークン取得のみを行う
- 取得したアクセストークンは**メモリにのみ保持**する（APIキーと同じ扱い）。リフレッシュトークンは得られないため、既知の制約（要件定義書§8）どおり「アプリを開いている間だけ」の同期になる
- スコープは `https://www.googleapis.com/auth/drive.appdata` のみ（要件定義書§5.6層5）

### ⚠️ 実行前提（このリポジトリの外で必要な作業）

**このコードだけでは動かない。** Googleアカウントへのログインと管理画面上の操作が要るため、コーディングでは代行できない。**本人が以下の手順を実行する。**

#### 手順1. プロジェクト作成 と Drive API 有効化

1. https://console.cloud.google.com/ を開き、Googleアカウントでログイン
2. 画面上部のプロジェクト選択 →「新しいプロジェクト」。名前は `IT-Index` などわかりやすいもの
3. 作成したプロジェクトを選択した状態で、検索バーに `Google Drive API` と入力 → 該当のAPIを開く →「有効にする」

#### 手順2. OAuth同意画面の設定

1. 左メニュー「APIとサービス」→「OAuth同意画面」
2. User Type は **「External」**（Google Workspace組織に属さない個人アカウントなので）
3. アプリ名: `IT-Index`、ユーザーサポートメール: 自分のメールアドレス、デベロッパーの連絡先情報: 自分のメールアドレス
4. スコープの追加で `https://www.googleapis.com/auth/drive.appdata` を追加。**このスコープは「機微なスコープ」として警告が出る**（要件定義書§8で既知の制約として記載済み）
5. 「テストユーザー」に、実際にこのアプリを使う自分のGoogleアカウントを追加する。**公開審査を受けない「テスト」ステータスのままでよい**（審査には数週間〜要ることがあり、個人利用の範囲では不要）。テストユーザーの上限は100人

#### 手順3. OAuthクライアントIDの発行

1. 左メニュー「APIとサービス」→「認証情報」→「認証情報を作成」→「OAuthクライアントID」
2. アプリケーションの種類: **「ウェブアプリケーション」**
3. 名前: `IT-Index Web Client` など
4. **「承認済みのJavaScript生成元」に以下を追加**（GISのトークンクライアントはこの設定だけを見る。リダイレクトURIの設定は不要）:
   - 開発時: `http://localhost:5173`（Viteの既定ポート）
   - 本番: GitHub Pagesの配信URL（例: `https://doryu0-04092.github.io`）※実際に配信を始めたら確定させる
5. 作成すると「クライアントID」が発行される。**これは秘密情報ではない**（公開クライアント向けのIDで、コードに埋め込む前提の値。APIキーとは性質が違う）

#### 手順4. クライアントIDをアプリに設定

1. リポジトリ直下に `.env.example` をコピーして `.env` を作成（`.env` は `.gitignore` 済みなのでコミットされない）
2. `VITE_GOOGLE_CLIENT_ID=` の後ろに手順3で取得したクライアントIDを貼る
3. `src/drive/config.ts` の `getGoogleClientId()` がこの値を読む。未設定の間は `null` を返すので、呼び出し側（未実装のUI）は「Drive同期は使えません」にフォールバックする想定

---

## 3. Drive APIラッパー（`driveApi.ts`）

`DriveFilesClient` インターフェース: `list()` / `download(fileId)` / `upsert(fileName, content, existingFileId?)`。

- `list()`: `GET /drive/v3/files?spaces=appDataFolder` — appDataFolderスコープなので、他のアプリのファイルは見えない（Driveのアクセス許可自体がそう作られている）
- `upsert()`: 既存ファイルIDがあれば `PATCH .../files/{id}?uploadType=media` で中身だけ差し替え、無ければ multipart POST で新規作成（`parents: ['appDataFolder']`）

---

## 4. 同期オーケストレーション（`sync.ts` の `runSync()`）

architecture.md §4.2 のシーケンス図をそのまま実装。

1. `driveFiles.list()` で `device-*.json` を列挙
2. 各ファイルを取得し、`JSON.parse` → `parseSyncFile()`（`src/core/validateSyncFile.ts`）で検証。**JSON構文エラー・検証NGはそのファイルだけスキップし、`skippedFiles` に記録して処理を続ける**（1台の壊れたファイルが同期全体を止めない）
3. ローカルの全 `notes`/`asks`/`aiTerms` を読み、`LocalSnapshot` を組み立てる
4. `mergeSnapshot(local, remoteFiles)` — 既存の決定的マージをそのまま呼ぶ
5. マージ結果をローカルDBへ反映（`upsertFromSync()` 系メソッド）
6. **マージ後の最新状態から**改めて自分の分だけを抽出し（`buildOutboundSyncFile()`）、自分のファイル（`device-<deviceId>.json`）だけを upsert する

### なぜ手順6は「マージ後」の状態から組み立てるのか

他端末の更新が自分の note を上書きした場合（相手の `updatedAt` が新しい場合）、その note はもう「自分が最後に編集したもの」ではなくなる（`lastEditedBy` が変わる）。マージ前の状態を使うと、もう自分のものではない note を自分のファイルに書いてしまう。マージ後に読み直すことで、常に「今、自分が最後に編集した分」だけが自分のファイルに載る。

### AIによる競合解決（`src/sync/resolveConflict.ts`）

`mergeSnapshot()` が返す `conflicts`（両端末で更新された語）に対して、コミット時の育成統合（`src/ai/distribution.ts`）と**同じプロンプト・パーサーを再利用**する。`resolveConflict()` は提案を返すだけで、DBへの適用は行わない（要件定義書§5.5「AIの出力は提案として保留し、承認するまで適用しない」）。承認画面UIから呼ぶ想定（未実装）。輸送手段に依存しないため[手動同期](./manual-sync.md)からも同じ関数を使う。

**決定的マージの結果（newest-wins）は competing の有無に関わらず常に適用される。** そのため鍵が無くても同期そのものは完結する（要件定義書§5.5「AIは同期の必須要素にしない」）。

---

## 5. 未決定・要検討

- **§2「実行前提」に記載のGoogle Cloud設定はコードでは代行できず、本人が実行する必要がある**（手順は§2に記載済み）。クライアントIDが `.env` に設定されるまで、`oauth.ts`/`driveApi.ts` は実際には一度も疎通確認できない
- **`aiTerms` の送信対象を「自分が作った語だけ」に絞れない**: `TermRecord` に作成端末を追うフィールドが無いため、`buildOutboundSyncFile()` は既知の `origin:'ai'` 語を全件含めている。`id` で和集合されるため同期の正しさは壊れないが、architecture.md が意図した「各ファイルが真の差分になる」という設計原則からは外れている。`TermRecord` に `createdBy: string`（deviceId）を追加するかどうかは要検討（Dexie version 3 が必要になる）
- **アクセストークンの有効期限切れハンドリングが無い**: `driveApi.ts` はトークン失効時のリトライ・再認可を行わない。401が返った場合にどう扱うかは未実装
- **同意画面（認可）の頻度は未実測（2026-07-27判断）**: リフレッシュトークンを持たない現在の設計だと、アクセストークン失効（約1時間）のたびに再認可を求める可能性がある。GISがブラウザ内で無言更新してくれる場合もあり得るため、**Google Cloud設定を済ませ次第、実際にどの程度の頻度で同意画面が出るかを実測してから対応を判断する**（サーバー側でリフレッシュトークンを保持する構成への転換は「自前サーバーを持たない」という要件定義書§3・§7の根本方針と衝突するため、実測結果を見てから判断する。安易に転換しない）
- **承認画面UI自体が無い**: `resolveConflict()` の提案をどう見せて承認を取るかはこれから
- **同期のトリガー（いつ `runSync()` を呼ぶか）が未実装**: 起動時・変更後デバウンスでの自動実行（architecture.md §4.2）はまだ配線していない
- **書き込みの原子性**: 非機能要件「書き込みはトランザクションで原子的に行う」に対し、`runSync()` 内のDB書き込み（notes/asks/terms）は現状トランザクションでまとめていない（複数リポジトリをまたぐため単純な `db.transaction()` 化ができておらず、途中失敗時のロールバックが無い）

---

## 関連文書

- [要件定義書](./requirements.md) — §5.5 サーバーを持たない同期の方針
- [アーキテクチャ](./architecture.md) — §4.2 シーケンス図・同期ファイルの構造
- [データ層設計](./data-layer.md) — `mergeSnapshot()` の仕様
- [AIクライアント設計](./ai-client.md) — 統合(マージ)プロンプトの共有元
