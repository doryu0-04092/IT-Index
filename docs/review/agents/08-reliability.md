# エージェント8 — 信頼性・データ整合性検証（it-index）

実施日: 2026-08-01

**対象**: `c:\Project\study\it-index`（`npm run build` 成功済み）
**検証方法**: Playwright（自分専用ポート、build後は`vite preview --port 4177`、StrictMode確認のみ`vite dev --port 4178`）。一時specは `c:\Project\study\it-index\e2e\investigate-reliability\reliability.investigate.spec.ts`、`c:\Project\study\it-index\playwright.reliability.config.ts` に作成（ソース非変更）。スクリーンショットは `c:\Project\study\it-index\docs\review\agents\screenshots\reliability\` に保存。補助的に既存ユニットテスト `src/repositories/settings.test.ts`・`src/ai/commitOrchestrator.test.ts` も実行し13件全通過。

**指摘なし（全項目で既知バグの回帰は確認されず、正常動作を確認）。** 以下、確認済み事項を統一フォーマットで記録する。

## [1] IndexedDBマイグレーション v1→v3は正常に機能する
- 種別: 観点（正の結果）
- 画面: 起動時（全画面共通の前提）
- 現象: `page.evaluate()`で`src/db.ts`のversion(1)相当（terms/notes/asks/chatSessions/chatMessages/settings）だけを持つ生IndexedDBを作成後、現行アプリ（Dexie version 1→2→3定義）で開かせたところ、正しくマイグレーションされた。マイグレーション後のストア構成は`['asks','chatMessages','chatSessions','keyStore','notes','settings','syncFolder','terms']`と一致し、`keyStore`（v2）・`syncFolder`（v3）が追加されていた。マイグレーション後に検索（27件ヒット）・設定モーダルの表示も正常動作した。
- 再現手順: 1. `indexedDB.deleteDatabase('it-index')`後、raw `indexedDB.open('it-index',1)`でv1相当ストアを構築 2. アプリを`page.reload()`で開かせる 3. `indexedDB.open('it-index')`でversion/objectStoreNamesを確認
- 証拠: テスト実行ログ「マイグレーション後のDB状態: {"version":30,"storeNames":[...]}」（Dexieはバージョン番号を内部的に×10で管理するため、rawバージョン30はDexieのversion(3)に相当し正常）。スクリーンショット: `docs/review/agents/screenshots/reliability/q1-after-open-v1-then-v3-app.png`, `q1-settings-modal-after-migration.png`
- 影響: なし（正常動作）
- 確信度: 確認済み

## [2] バグ1（StrictMode二重effect実行競合）は回帰していない
- 種別: 観点（正の結果、既知バグの回帰確認）
- 画面: 起動時
- 現象: `src/repositories/settings.ts:19-32`（`db.transaction('rw', db.settings, ...)`で`get→無ければput`を1トランザクションに包む実装）を確認済み。修正はコード上維持されている。StrictModeの意図的な二重effect実行が発生するdevサーバー（production buildの`vite preview`ではStrictMode二重実行は発生しないため`vite dev`を使用）で起動を実測したところ、`settings`ストアのレコード件数は常に1件（衝突なし）、検索は27件正常ヒット、`console.error`/`pageerror`も0件だった。
- 再現手順: 1. `vite dev`（StrictMode有効）でDB初期化状態からアプリ起動 2. 1秒待機後、`settings`ストアの`count()`を直接確認 3. 検索動作を確認
- 証拠: ログ「settingsストアのレコード件数（1件が正常、2件なら衝突していた可能性）: 1」、「StrictMode下での"API"検索結果件数: 27」。スクリーンショット: `q2-strictmode-after-boot.png`。ユニットテスト`settings.test.ts`「does not throw when get() is called concurrently」も通過（`npx vitest run`で13件中に含め実行、全通過）。
- 影響: なし（正常動作）
- 確信度: 確認済み

## [3] 複数タブ同時操作でデータ破損は発生しない
- 種別: 観点
- 画面: 検索画面／チャット画面（複数タブ）
- 現象: 同一コンテキストの2タブで同時に`it-index`を開き、タブAで検索を継続しながらタブBで用語詳細→チャット開始→送信→確定という一連の書き込み操作を実行。タブAの検索は影響を受けず継続動作（30件→30件）、タブB側の確定処理も正常完了（`.search-screen`に遷移）。確定後のDB直接確認では`settings`は1件のまま、`chatSessions`は`status:"open"`のまま残っていた（`termId`なしの自由チャットセッション。バグ7のガードにより空メッセージでない限り自動ではcommittedにならない設計と整合）。例外は捕捉されなかった。
- 再現手順: 1. 同一`BrowserContext`で2ページ作成 2. 両方で`waitForSeedSettled` 3. タブAで検索操作、タブBでチャット確定操作を並行実施 4. `indexedDB`を直接読んで整合性確認
- 証拠: ログ「2タブ操作後のDB状態: {"settingsCount":1,"sessions":[{"status":"open"}]}」。スクリーンショット: `q3-tabA-after-tabB-write.png`, `q3-tabB-after-commit.png`, `q3-tabA-after-reload.png`
- 影響: なし（実測範囲では破損なし）
- 確信度: 確認済み（ただし「確認できなかったこと」参照）

## [4] バグ7（空セッションの自動処理）は回帰していない。ただし前提アーキテクチャが変更されている
- 種別: 観点（既知バグの回帰確認）＋事実の訂正
- 画面: チャット画面／ホーム画面
- 現象: **重要な事実誤認訂正**: `docs/ui-pc.md`§3バグ6・バグ7が言及する`commitOrchestrator.recoverStaleSessions()`（15分放置セッションの起動時自動回収トリガー）は、**現在のコードベースに存在しない**（`grep -rn "recoverStaleSessions" src`で0件）。`src/ai/commitOrchestrator.ts:26-40`のコメントにより、2026-07-30の改訂で「自動トリガー（別語チャットを開いた／15分放置／起動時の放置セッション回収）を全廃し、確定操作は明示的なボタン実行（`triggerCommit`）のみにした」とアーキテクチャ変更が明記されている。バグ7自体の直接原因だった自動トリガーはもう存在しないため、当時と同じ経路での再現はできない。
  一方、バグ7の修正内容そのもの（`commit()`内のメッセージ0件チェック、`src/ai/commitOrchestrator.ts:53-57`）は現在も存在し、`triggerCommit`経由でも機能する。実測: 「AIに聞く」ボタン押下直後に離脱→再訪しても、AI呼び出しは一度も発生せず（`aiCalled: false`）、さらにUI側も`src/ui/pc/ChatScreen.tsx:231`で`disabled={messages.length === 0}`により確定ボタン自体が無効化されている（二重の安全策）。
- 再現手順: 1. 用語詳細→「この語についてAIに聞く」クリック（メッセージ0件のままセッション作成） 2. 一言も送らず検索画面へ離脱 3. 同じ用語のチャットを再訪（`findOpenSessionByTermId`で同一セッション再利用） 4. 確定ボタンの状態とAI呼び出し有無を確認
- 証拠: ログ「離脱時点でAI呼び出しが発生したか: false」、「空セッション再訪時、確定ボタンがdisabledか: true」。スクリーンショット: `q4-after-leaving-empty-session.png`, `q4-after-commit-empty-session.png`。ユニットテスト`commitOrchestrator.test.ts`「recoverStaleSessions skips stale sessions...」を含む全13件通過（テスト名は旧仕様のままだが、実装は`commit()`共通経路でカバー）。
- 影響: なし（現行仕様では自動回収トリガー自体が存在しないため、バグ7の発生条件そのものが構造的に消えている）。ただし`docs/ui-pc.md`のバグ6・7の記述は現在のアーキテクチャと一致しなくなっており、**ドキュメントの陳腐化**がある（ソース変更・ドキュメント修正は本タスクの範囲外のため実施せず、事実として報告のみ）
- 確信度: 確認済み

## [5] fetch reject時のエラー日本語化は機能している（バグ8原因2の回帰確認）
- 種別: 観点（既知バグの回帰確認）
- 画面: APIキー入力画面（`.api-key-prompt`）
- 現象: `page.route()`で`https://api.anthropic.com/v1/messages`と`/v1/models`を`abort('failed')`させ、CORS/オフラインを模擬。APIキー接続確認ボタン押下後、「AIサービスに接続できませんでした（ネットワークの問題、またはブラウザ・拡張機能による通信制限の可能性があります）。時間をおいて再度お試しください。」という日本語文言が表示され、`Failed to fetch`等の未翻訳の生英語エラーは検出されなかった（`src/ai/networkError.ts`の`fetchOrTranslateNetworkError`実装どおり）。
- 再現手順: 1. AI関連fetchを`abort('failed')`させるルートを設定 2. APIキー入力→接続確認 3. 表示文言を確認
- 証拠: ログ「未翻訳の生英語エラーが含まれるか（api-key-prompt）: false」、実際の表示文言ログにも日本語案内文のみ確認。スクリーンショット: `q5-apikeyprompt-fetch-reject.png`
- 影響: なし（正常動作）
- 確信度: 確認済み

## [6] globalErrorはXボタンで確実に消せる（バグ6の修正確認）
- 種別: 観点（既知バグの回帰確認）
- 画面: 全画面共通ヘッダー下（Toast）
- 現象: メッセージ送信済みセッションの確定処理だけを`abort('failed')`で失敗させ、`commitOrchestrator.onError`→`App.tsx`の`globalError`→`Toast`表示という実経路を発火させた。Toastには「確定処理に失敗しました: AIサービスに接続できませんでした...」の日本語文言が表示され、✕ボタン押下で即座に非表示になった（`src/ui/pc/Toast.tsx`の`onDismiss`実装どおり）。
- 再現手順: 1. チャットで送信を成功させメッセージを1件作る 2. 確定ボタン押下前にAI呼び出しルートをabortに切り替え 3. 確定ボタンをクリック 4. Toast表示を確認後、✕ボタンをクリックして消えることを確認
- 証拠: ログ「Q6: 確定処理失敗後にtoast-error（globalError）が表示されたか: true」→「Xボタン押下後もtoast-errorが残っているか: false」。スクリーンショット: `q6-toast-before-dismiss.png`, `q6-toast-after-dismiss.png`
- 影響: なし（正常動作）
- 確信度: 確認済み

---

## 確認できなかったこと
- **複数タブでの真の同時書き込み（同一ミリ秒での競合）**: Playwrightの操作は人間の操作速度に近いシーケンシャル実行になりがちで、`db.transaction`のロック機構が守っている「本当に同一マイクロタスクで衝突する」ケースは今回のテストでは再現できていない（[3]はあくまで「タブAの読み取りとタブBの書き込みが時間的に重なる」実測に留まる）。真の同時書き込み競合（例: 2タブから同一`termId`のセッションを同時に`createSession`する等）は未検証。
- **`docs/ui-pc.md`記載のバグ6の完全な原因経路（`recoverStaleSessions`が`keyReady`前に走る問題）**: 該当関数自体が現行コードに存在しないため、当時の発生条件そのものを再現できず、「原因経路が塞がれている」ことの間接確認（grep 0件、アーキテクチャ変更コメントの存在）に留まる。認証未了状態での他の自動処理（`syncFolderRepo.get()`によるローカルフォルダ自動取り込み等）がglobalErrorを誤って埋めるケースは個別に検証していない。
- **ブラウザタブを実際に閉じる（`page.close()`）操作でのセッション状態**: 今回は「画面遷移による離脱」のみ検証し、タブそのものを閉じた場合のIndexedDBトランザクション中断・不整合は未検証。
- **`Promise.all([importSeed(), importSeed()])`相当の直接的な二重呼び出し**: アプリのビルド済みバンドルから`importSeed`/`settingsRepo.get`を直接呼び出す手段がなく（モジュールがグローバル公開されていない）、StrictModeの二重effectという間接的な手段でのみ検証した。ユニットテスト側（`settings.test.ts`）では直接的な同時呼び出しテストが存在し通過しているが、これは今回新規実行したものではなく既存テストの再確認。
- **性能・UI/UX・アクセシビリティ観点**: 依頼範囲外のため未検証（他エージェント担当）。
