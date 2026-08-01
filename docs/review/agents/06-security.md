# エージェント6 — セキュリティ検証（it-index）

実施日: 2026-08-01

対象: `c:\Project\study\it-index`。Stage Bで既に実行済みのゲート（gitleaks/npm audit/npm audit signatures/semgrep）は重複実行せず、手動観点の調査に集中した。実在の外部サービスへの攻撃的な検証は行っていない。

## [1] Gemini APIキーがURLのクエリパラメータで送信される
- 種別: 観点
- 画面: チャット画面（Geminiプロバイダ選択時）、APIキー設定画面（モデル一覧取得時）
- 現象: Claude・OpenAIはAPIキーをHTTPヘッダー（`x-api-key` / `Authorization: Bearer`）で送るのに対し、Geminiだけはリクエスト先URLのクエリパラメータ`?key=...`にAPIキーをそのまま埋め込んでいる。これはGoogle Generative Language APIの公式仕様どおりの実装だが、結果としてAPIキーがブラウザの通信ログ・DevTools NetworkタブのURL欄・プロキシ/CDNのアクセスログに平文で残りやすい経路になっている。
- 再現手順: 1. Geminiプロバイダを選択してAPIキーを設定する 2. チャットを送信する 3. DevToolsのNetworkタブでリクエストURLを見る 4. `generativelanguage.googleapis.com/...?key=<APIキー>`がURL欄にそのまま表示される
- 証拠: `src/ai/providers/gemini.ts:21`、`src/ai/providers/gemini.ts:61`（比較対象: `src/ai/providers/claude.ts:28`、`src/ai/providers/openai.ts:34`はヘッダー渡し）
- 影響: この端末やネットワーク経路上でHTTPログ・プロキシログ・ブラウザ履歴を見られる立場の第三者がいた場合、Gemini利用者のAPIキーだけ他の2プロバイダより露出リスクが高い。Google API自体の仕様上アプリ側では回避できない制約。
- 確信度: 確認済み

## [2] Content-Security-Policyが一切設定されていない
- 種別: ゲート違反
- 画面: 全体
- 現象: `index.html`にCSPの`<meta http-equiv="Content-Security-Policy">`が無く、`Referrer-Policy`等の他のセキュリティヘッダーも無い。サーバーレスの静的ホスティング構成（Vercel/Netlify等の設定ファイルも本リポジトリには存在しない）なので、HTTPレスポンスヘッダーとしてのCSP付与手段も現状ない。
- 再現手順: 1. `index.html`を開く 2. `<head>`内を確認する 3. CSP関連のmetaタグが無いことを確認
- 証拠: `index.html:1-16`（全内容を確認、該当タグなし）。リポジトリ内に`vercel.json`/`netlify.toml`/`_headers`等のホスティング設定ファイルも存在しない
- 影響: 万一将来XSSの経路が生まれた場合（現時点では[3]の調査で確認された経路は無い）、CSPによる多層防御が機能しない。特に本アプリは3種のAI APIへ直接キーを送る構成のため、XSS発生時の被害（キー窃取）が通常のアプリより大きい。
- 確信度: 確認済み

## [3] XSS経路: 調査した範囲では確認されず（正の結果として記録）
- 種別: 観点
- 画面: 用語詳細画面（AIノート表示）、チャット画面
- 現象: `grep -rn "dangerouslySetInnerHTML" src/`はリポジトリ全体で0件。AI生成テキスト（`note.body`）は`TermDetailScreen.tsx:58`で`<p className="term-detail-body">{note.body}</p>`としてReactの子要素展開（自動エスケープ）で表示されている。チャットメッセージも`ChatScreen.tsx:168`で`<p>{m.content}</p>`と同様。Mermaid図は`TermDetailScreen.tsx:59-65`で`<pre key={i}>{d}</pre>`としてプレーンテキスト表示のみで、Mermaidレンダリングライブラリ自体がpackage.jsonに存在せず、SVG/HTMLとして解釈される経路が無い（「図（Mermaid、未描画）」という文言どおり、意図的に未描画）。
- 証拠: `src/ui/pc/TermDetailScreen.tsx:56-66`、`src/ui/pc/ChatScreen.tsx:165-170`
- 影響: なし（現時点でXSS経路は見つからなかった）
- 確信度: 確認済み

## [4] APIキーの保存方式: 設計どおり実装されている（正の結果として記録）
- 種別: 観点
- 画面: APIキー設定画面
- 現象: セッションのみモードでは`sessionCredential`はモジュールスコープのJS変数（`src/keystore/apiKeyStore.ts:18`）に保持されるのみで、IndexedDBには一切書き込まれない。永続化（「この端末に保存する」）を選ぶと、WebAuthn PRF拡張の出力（32バイト）をAES-256-GCMの鍵material化し（`crypto.ts:17-19`）、APIキー本体を暗号化した`ciphertext`と`iv`のみを`KeyStoreRepository.put()`（`src/repositories/keyStore.ts:16-18`）でIndexedDBに書き込む。保存レコードのフィールドは`{key, provider, model, credentialId, ciphertext, iv}`（`apiKeyStore.ts:91`）で、平文APIキーのフィールドは存在しない。単体テスト（`apiKeyStore.test.ts`）でも復号ラウンドトリップの整合性が確認されている。
- 証拠: `src/keystore/apiKeyStore.ts:18,63-93`、`src/keystore/crypto.ts:17-30`、`src/repositories/keyStore.ts:10-24`
- 影響: なし（設計どおり、平文APIキーはIndexedDBに残らない）
- 確信度: 推測（**注意**: ブラウザを実際に起動しPlaywrightで`page.evaluate()`によりIndexedDBの中身を直接覗く検証は実施できなかった。「確認できなかったこと」欄参照。コード読解とVitestユニットテストの内容からの確信度の高い推測に留まる）

## [5] File System Access API / getUserMedia の権限要求: 設計どおり実装されている（正の結果として記録）
- 種別: 観点
- 画面: 設定画面（共有フォルダ同期・ローカルデータ同期）、QRスキャン画面
- 現象: `showDirectoryPicker({ mode: 'readwrite', startIn })`（`src/manualSync/folderTransport.ts:60`）はユーザー操作起点でのみ呼ばれ、再訪時は`queryPermission`→必要な場合のみ`requestPermission`（`folderTransport.ts:64-69`）という最小要求の順序を踏んでいる。`readwrite`モードは同期機能の要件上必要（ノート・語データの書き戻しを行うため）で、過剰要求ではない。カメラは`getUserMedia({ video: { facingMode: 'environment' } })`（`src/manualSync/qrScanner.ts:19`）で映像のみ要求し、音声は要求していない。画面を離れる際の`stop()`でトラックを確実に止める設計（`qrScanner.ts:49-53`）。
- 証拠: `src/manualSync/folderTransport.ts:52-69`、`src/manualSync/qrScanner.ts:9-54`
- 影響: なし
- 確信度: 確認済み

## [6] `.env.example`: 秘密情報の記載なし（正の結果として記録）
- 種別: 観点
- 画面: 該当なし（ビルド設定）
- 現象: `.env.example`は4行のみで、変数は`VITE_GOOGLE_CLIENT_ID`（値は空欄）だけ。コメントにも「クライアントIDそのものは秘密情報ではなく公開して問題ない」と明記されており、実際にOAuthクライアントID（種類:ウェブアプリケーション）は秘密情報ではない。APIキー等の秘密情報を格納する変数は無い。
- 証拠: `.env.example`（全4行を確認、変数名`VITE_GOOGLE_CLIENT_ID`のみ。**値は転記していない**）
- 影響: なし
- 確信度: 確認済み

## [7] Google Drive OAuth（休眠中）のトークン保管方式: 設計どおり（正の結果として記録）
- 種別: 観点
- 画面: 設定画面（Drive連携、現状未着手・休眠中の機能）
- 現象: `createDriveAuthClient`はアクセストークンをクロージャ内のローカル変数（`accessToken`、`src/drive/oauth.ts:53`）にのみ保持し、IndexedDBや`localStorage`への永続化は行っていない。タブを閉じれば消える設計（コメントにも明記）。リフレッシュトークンは取得しないImplicitフロー相当。実際に動かすには開発者側でGoogle Cloud Consoleの設定が別途必要であり、本リポジトリのコードだけでは完結しない（未着手）。
- 証拠: `src/drive/oauth.ts:1-16,52-53`
- 影響: なし。ただし機能自体が休眠中のため実運用での検証はできていない
- 確信度: 確認済み（コード上の設計の確認に限る。実際のOAuth往復は未検証）

## [8] 外部通信先の一覧（意図しない送信先は確認されず）
- 種別: 観点
- 画面: 全体
- 現象: `grep -rn "fetch(\|https://" src/`で洗い出した外部通信先は以下のみ:
  - `api.anthropic.com`（Claude、AI呼び出し用）
  - `api.openai.com`（OpenAI、AI呼び出し用）
  - `generativelanguage.googleapis.com`（Gemini、AI呼び出し用）
  - `www.googleapis.com`（Google Drive API、休眠中機能）
  - `accounts.google.com/gsi/client`（Google Identity Services、休眠中機能のOAuthスクリプト読み込み）
  - `fonts.googleapis.com` / `fonts.gstatic.com`（`index.html`のWebフォント読み込み。`preconnect`のみで、ユーザーデータの送信は伴わない）
  いずれもアプリの機能（AI連携・Drive同期）に対応した想定内の送信先で、意図しない外部送信先（アナリティクス・広告・不明なサードパーティ等）は確認されなかった。
- 証拠: 各`src/ai/providers/*.ts`、`src/drive/*.ts`、`index.html:7-10`
- 影響: なし
- 確信度: 確認済み

---

## 確認できなかったこと
- **[4]のIndexedDB実物確認**: PlaywrightでダミーAPIキーをUI経由で実際にセットし、`page.evaluate()`でIndexedDBの生データを直接覗く検証は実施していない。理由: (a) 永続化（`enablePersistence`）にはWebAuthn PRF対応の実認証器（Windows Hello等）またはPlaywrightの仮想認証器（CDP Virtual Authenticator）のセットアップが必要で、本セッションでは仮想認証器のPRF拡張対応状況を検証する時間的余裕がなかった、(b) 本プロジェクトのe2eテスト（`e2e/`配下）を検索したがWebAuthn/仮想認証器を使うテストは見つからなかった。代わりにコード読解（`apiKeyStore.ts`・`crypto.ts`・`keyStore.ts`）とVitestユニットテスト（`apiKeyStore.test.ts`、フェイクWebAuthnクライアント使用）の内容から、平文APIキーがIndexedDBに書き込まれないことを高い確信度で推測したに留まる。
- **セッションのみモード（永続化しない場合）のIndexedDB実物確認**: 同上の理由でPlaywrightでの直接確認は未実施。コード上（`sessionCredential`はモジュール変数のみ）は問題ないと判断できるが、ビルド後のバンドルやブラウザ拡張機能等による予期しない永続化経路の有無までは確認していない。
- **Geminiプロバイダの実疎通確認**: コード内コメントに「有効なGemini APIキーで実疎通確認はできていない」とある（`gemini.ts:7`）とおり、本検証でも実APIキーは使用しない方針のため、レスポンス形式の実際の挙動は未検証。ただしAPIキーがURLに載る構造自体はコードから確定的に確認できている。
- **Google Drive OAuth往復の実機確認**: 機能自体が休眠中（開発者側の外部設定が未着手）のため、実際のOAuth同意画面・トークン取得フローの動作は確認していない。
- **npm audit / gitleaks / semgrepの再実行**: Stage Bで実施済みのため本タスクでは重複実行していない（指示どおり）。
- **ビルド後の本番バンドル（`dist/`）に対する検証**: ソースコードレベルの確認に留まり、Viteのビルド設定（コード分割・環境変数の埋め込み等）によって本番バンドルに秘密情報や意図しない文字列が混入していないかまでは確認していない。
