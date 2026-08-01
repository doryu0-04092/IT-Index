# エージェント9 — 保守性・コード構造検証（it-index）

実施日: 2026-08-01

対象: `c:\Project\study\it-index\src`（静的読解のみ、ブラウザ操作なし、コード変更なし）。

## [1] App.tsxは4つの独立した状態クラスタを内部境界なく束ねている
- 種別: 保守性・構造（関心の分離）
- 対象: `src/App.tsx`
- 現象: 1コンポーネントに19個の`useState`＋4個の`useEffect`があり、以下を扱う: (a)画面ルーティング（`Screen`型, `topNavCurrent`, `screenKey`, `setScreen`呼び出し）、(b)シードデータのブートストラップ（`seedError`/`seedSettled`、140行目のeffect）、(c)WebAuthn資格情報復元バナーのライフサイクル（`hasPersistedKey`/`keyReady`/`authenticating`/`authError`、216行目のeffect、227行目の`handleAuthenticate`）、(d)ローカルフォルダ同期のライフサイクル＋初回バナー（`localFolder`/`localFolderChecked`/`firstRunDismissed`/`firstRunBusy`/`firstRunError`、160行目と200行目のeffect）。クラスタ(b)と(c)は自分のstateしか読み書きせず、(a)・(d)とのデータ依存が一切無いため、`useSeedImport()` / `useApiKeyAuth()` フックとして結合コストなく抽出可能。一方クラスタ(d)はチャット確定フローと本質的に絡んでいる（272行目の`commitSessionWithLocalSync`は`commitAndReturnToSearch`/`commitPendingTerm`から呼ばれ、`syncPendingChats`は401/405行目の`ChatScreen`の`onBack`/`onBackToTerm`から呼ばれる）ため、同じようにきれいには分離できない。
- 証拠: `App.tsx:68-91`（state宣言）, `App.tsx:140-158`（シードeffect）, `App.tsx:216-243`（認証effect＋handler）, `App.tsx:160-214`（ローカルフォルダeffect＋setup）, `App.tsx:272-309`（コミットフローとローカルフォルダ・チャットセッションの結合）
- 影響: 起動時の新しい振る舞い（新しいバナー、新しい永続設定）を追加するたびにこの1ファイルを触り、無関係なstateとの干渉が無いか読み直す必要がある。シード取り込みと認証のクラスタは低リスク・低コストで抽出できる候補だが、ローカルフォルダのクラスタはそうではなく、無理に分離しても結合を移すだけになる可能性が高い。
- 確信度: 確認済み（コード上の依存関係を実際に追跡）

## [2] `src/index.css`は単一のグローバル・非スコープのスタイルシートで、命名規則だけが衝突を防ぐ唯一の防波堤
- 種別: 保守性（CSS設計）
- 対象: `src/index.css`
- 現象: CSS Modulesもコンポーネントスコープのスタイルも無く、命名規則を強制するlintルール（stylelint設定も見当たらない）も無い。全80個のトップレベルクラスセレクタを列挙し（`grep -oE '^\.[a-zA-Z][a-zA-Z0-9_-]*' index.css`）突き合わせたところ、実際には画面固有クラス（`search-*`, `chat-*`, `term-detail-*`, `term-picker-*`, `api-key-*`, `onboarding-*`, `settings-*`, `history-*`）に一貫してプレフィックスが付けられ、少数の共有ユーティリティクラス（`btn-*`, `modal-*`, `toast*`, `skeleton*`）が意図的に再利用されている。**現時点で実際の名前衝突はゼロ**——この規律はこれまで守られてきている。
- 証拠: `src/index.css`から生成した全クラス一覧（80セレクタ、全て画面プレフィックス付きか意図的な共有ユーティリティ名）
- 影響: これは現在の欠陥ではなく潜在的リスク。将来の貢献者が例えば無関係な新しいコンポーネントに2つ目の`.term-detail-meta`を追加しても、ツールチェーン側で検知する仕組みが何も無く、静かに上書きされる。現在の規律は不文律（規約のみ、強制なし）のため、リスクはファイルサイズに比例するというより、このファイルに触る人数に比例して増える。
- 影響: なし（現時点）。将来リスクとして記録する。
- 確信度: 確認済み（現時点で衝突なしは確認済み。将来リスクは推測）

## [3] 循環依存は見つからなかった（問題なし）
- 種別: 保守性（依存構造）
- 対象: `src/` 全体
- 現象: `npx madge --circular --extensions ts,tsx src`を実行——結果「No circular dependency found!」（116ファイル処理）。一見疑わしく見えた1経路（`keystore/apiKeyStore.ts`が`ai/providers/types.ts`から`AiProvider`をimportし、`ai/providers/index.ts`が`keystore/apiKeyStore.ts`から`AiCredential`をimportする）も手動確認したが、これは2つの異なるファイル（`types.ts`と`index.ts`）であり、どちらもループを閉じておらず、単に2つのディレクトリが異なるエントリファイル経由で互いの**型**を参照しているだけと確認した。全体のレイヤリングは明快: `types.ts` → `db.ts`/`repositories/*` → `core/`, `ai/`, `keystore/`, `localData/`, `sync/`, `manualSync/`, `drive/` → `ui/`。
- 証拠: madgeツールの出力。`src/keystore/apiKeyStore.ts:1-2`と`src/ai/providers/index.ts:1-6`, `src/ai/providers/types.ts`（importなし）の手動確認
- 影響: なし。問題なし、と明言する。
- 確信度: 確認済み（ツール実行＋手動確認）

## [4] `err instanceof Error ? err.message : String(err)` が5ファイル11箇所で一字一句重複
- 種別: 重複ロジック
- 対象: `App.tsx`, `ui/pc/ApiKeyPrompt.tsx`, `ui/pc/ChatScreen.tsx`, `ui/pc/LocalFolderPanel.tsx`, `ui/pc/SettingsModal.tsx`
- 現象: 同一のエラー正規化式が`App.tsx:135,150,210,239`、`ui/pc/ApiKeyPrompt.tsx:64,92`、`ui/pc/ChatScreen.tsx:81`、`ui/pc/LocalFolderPanel.tsx:57,77,107`、`ui/pc/SettingsModal.tsx:66`——11箇所に一字一句同じロジックで登場し、共有ヘルパー（例: `errorMessage(err: unknown): string`）が無い。このコードベースは他のエラーフォーマット関心事は既に集約している（HTTPステータス→日本語テキストの`src/ai/errors.ts`、fetch rejectionの`src/ai/networkError.ts`）にもかかわらず。
- 証拠: `App.tsx:135`, `App.tsx:150`, `App.tsx:210`, `App.tsx:239`, `ui/pc/ApiKeyPrompt.tsx:64`, `ui/pc/ApiKeyPrompt.tsx:92`, `ui/pc/ChatScreen.tsx:81`, `ui/pc/LocalFolderPanel.tsx:57`, `ui/pc/LocalFolderPanel.tsx:77`, `ui/pc/LocalFolderPanel.tsx:107`, `ui/pc/SettingsModal.tsx:66`
- 影響: バグのリスクは低い（1行のロジックのため）が、将来unknown errorの文字列化方法を変更する場合（例: `AggregateError`の扱い、開発時のスタックトレース表示）、11箇所を個別に修正する必要があり、いくつか見落とす可能性が高い。
- 確信度: 確認済み（grepで全11箇所を特定）

## [5] 3つのAIプロバイダアダプタがHTTPエラー・キー未設定チェックを一字一句重複させている
- 種別: 重複ロジック
- 対象: `src/ai/providers/claude.ts`, `src/ai/providers/gemini.ts`, `src/ai/providers/openai.ts`
- 現象: 各ファイルが（`send()`で1回、`listXModels()`で1回の）計2回、同一の3行ブロックを繰り返している:
```
if (!res.ok) {
  const rawBody = await res.text().catch(() => '');
  throw new AiApiError('<provider>', res.status, rawBody);
}
```
  ——プロバイダ名の文字列リテラルが違うだけで計6箇所（`claude.ts:40-43,76-79`, `gemini.ts:37-40,64-67`, `openai.ts:39-42,64-67`）。加えて`if (!apiKey) { throw new Error('APIキーが設定されていません'); }`が3つ全ての`send()`関数で一字一句重複（`claude.ts:20-22`, `gemini.ts:17-19`, `openai.ts:18-20`）。
- 証拠: 上記のfile:line範囲
- 影響: `src/ai/providers/index.ts`は既に共有`assertOk(res, provider)` / `requireApiKey(apiKey)`ヘルパーを置く自然な場所として存在する（この3アダプタが実装する`AiClient`/`AiProvider`型を既に再エクスポートしているモジュールのため）。それが無いと、将来の4つ目のプロバイダが同じブロックを再度コピペする可能性が高く、エラーラップの挙動変更（例: `res.headers`もログに残す等）は6箇所近似コードを正しく編集する必要がある。
- 確信度: 確認済み（grep結果で3ファイル×2箇所ずつ、完全一致を確認）

## [6] `score()`の再利用以外、日付フォーマットやリポジトリパターンに意味のある重複は見当たらなかった（問題なし）
- 種別: 重複ロジック（問題なし）
- 対象: 日付フォーマット・IndexedDB操作パターン全般
- 現象: 日付フォーマットの重複を確認したが、日付関連の呼び出し箇所は3箇所のみ（`localFolderSync.ts:44,48`がファイル名を組み立て、`noteFile.ts:21`がMarkdownヘッダを組み立て、`HistoryScreen.tsx:96`が表示用タイムスタンプをフォーマット）——それぞれ目的が異なり（ファイル名 vs ドキュメントメタデータ vs UI表示）、同じロジックの重複ではない。リポジトリファイル（`repositories/*.ts`）は薄く一貫したDexieラッパーで、そこのパターン反復（get/put/toArray）は通常のデータアクセス定型文であり重複ビジネスロジックではなく、各リポジトリ固有の非自明なロジック（例: `notes.ts`の`applyCommit`の履歴蓄積分岐）は他のどこにもコピペされていない。
- 証拠: `toLocaleDateString|toLocaleString|new Date(`のgrepが上記4箇所のみをヒット
- 影響: なし。問題なし、と明言する（無理に指摘を作らない）。
- 確信度: 確認済み

## [7] 型の規律は強固——`any`はゼロ、全ての`as`アサーションに正当な理由がある（問題なし）
- 種別: 型設計（問題なし）
- 対象: `src/` 全体
- 現象: `grep -rn ": any\b|<any>|any\[\]|Record<string, any>"`を全`.ts/.tsx`に対して実行——**マッチ0件**（本番・テストコードともに`any`の使用箇所なし）。全ての`as`型アサーションは3つの正当なカテゴリに分類できる: (1)信頼できない外部JSONのランタイム検証で、必ず手動での形状/`typeof`チェックの直後に配置（`core/validateSeed.ts:31,51,62,82`, `core/validateSyncFile.ts:17,44-46,53,67,79,87`, `ai/parseDistribution.ts:47,62,75,87-90`, `ai/parseMerge.ts:21,31`, `localData/termsFile.ts:52,72,84,104`）——TypeScriptは型述語関数無しに`unknown`から深い形状の絞り込みを推論できないため、このパターンは不可避、(2)要求した内容から構造的に正しいことが分かっているDOM APIの戻り値を絞り込む場合（`keystore/webauthn.ts:66-100`が`publicKey`オプション付きで`navigator.credentials.create/get`を呼んだ後に`Credential | null` → `PublicKeyCredential | null`をキャスト。`HistoryScreen.tsx:78,93`と`SearchScreen.tsx:173`がCSSカスタムプロパティオブジェクトを`React.CSSProperties`（`--*`変数のインデックスシグネチャを持たない）にキャスト）、(3)テスト専用モック（`repositories/syncFolder.test.ts:7`の`as unknown as FileSystemDirectoryHandle`）。いずれも型設計の手抜きには見えない。
- 証拠: grep結果（`any`ヒット0件）。上記の各`as`カテゴリのfile:line一覧
- 影響: なし。問題なし、と明言する。
- 確信度: 確認済み

## [8] `buildSubjectContext()`——実際のフォールバックロジックを持つ4分岐関数——がどのテストからも呼ばれていない
- 種別: テストカバレッジの空白
- 対象: `src/ai/subjectContext.ts`
- 現象: この関数は4つの異なる結果を持つ: `termId === null` → 自由モード（30行目）、`term`がリポジトリに見つからない → termIdが渡されているにもかかわらず自由モードへフォールバック（33行目）、ノートは存在するが本文が空白のみ → `existingNoteBody: null`（43行目）、通常のterm-with-noteケース。`src/ai/chat.test.ts`が`SubjectContext`に言及する唯一のテストファイルだが、そこでは**型**をimportして`SubjectContext`オブジェクトを手動構築しているだけ（66, 90, 110, 133行目）——`buildSubjectContext()`自体は一度も呼んでいない。他のテストファイルは`subjectContext`に一切言及していない。「自由モードへのフォールバック」の2分岐（termId欠落、term欠落）と空白トリミング分岐は、テストスイートで全く運動されていない。
- 証拠: `src/ai/subjectContext.ts:30,33,43`。`buildSubjectContext`が`*.test.ts`ファイルのどこからも呼ばれておらず、`App.tsx`と`ai/chat.ts`からのみ呼ばれていることをgrepで確認
- 影響: 「term見つからず→自由チャットへフォールバック」経路（実際の削除済みterm境界ケース）や「空白のみのノートは空扱い」ルールでの回帰は、`npm test`では検出されず、手動/E2Eテストでしか検出されない。
- 確信度: 確認済み

## [9] AIプロバイダアダプタ（`claude.ts`, `gemini.ts`, `openai.ts`）にテストファイルが無く、実際のHTTP境界・エラーマッピングロジックが未テスト
- 種別: テストカバレッジの空白
- 対象: `src/ai/providers/claude.ts`, `gemini.ts`, `openai.ts`
- 現象: `ai/providers/index.ts`と`ai/providers/types.ts`（両方とも`.test.ts`ファイルあり）とは異なり、3つの具体アダプタにはテストが無い。それぞれ一度も運動されない非自明なレスポンス解析ロジックを含む: Claudeの`extractText()`は複数ブロックのレスポンスをフィルタ/結合する（`claude.ts:55-59`）、Geminiの`send()`は`candidates`/`parts`/`text`が欠落した場合に`?? []` / `?? ''`へフォールバックする（`gemini.ts:43-44`）、OpenAIの`listOpenAiModels()`はモデルIDに対し2段階の正規表現include/excludeフィルタを実行する（`openai.ts:72-73`）。これらの分岐（空の`candidates`配列、`type !== 'text'`のコンテンツブロック、includeパターンにはマッチするが除外すべきモデルID）のいずれも結果を検証するテストが無い。
- 証拠: `src/ai/providers/claude.ts:55-59`, `gemini.ts:42-44`, `openai.ts:69-74`。ファイル一覧で`claude.test.ts`/`gemini.test.ts`/`openai.test.ts`が`src/ai/providers/`に存在しないことを確認
- 影響: このロジックは実ネットワーク呼び出し無しでテスト可能（コードベースは既に他所で`fetch`/`fetchOrTranslateNetworkError`を`vi.fn()`でモックしている）ため、このギャップは構造的な問題ではなく単に書かれていないだけ。Geminiのレスポンス形状の変更やOpenAIのより厳格なIDフィルタは、赤テストが無いまま静かに壊れる可能性がある。
- 確信度: 確認済み

## [10] `keystore/webauthn.ts`にテストが無いのは意図的・文書化済みの妥当な除外であり、空白ではない（問題なし）
- 種別: テストカバレッジ（問題なし、と明言）
- 対象: `src/keystore/webauthn.ts`
- 現象: ファイル自身の冒頭コメント（`webauthn.ts:1-6`）が、実際の認証器を必要とするため単体テストから除外していること、消費側のロジック（`keystore/apiKeyStore.ts`）は`WebAuthnClient`インターフェースにのみ依存するためフェイクでテスト可能であることを明記している。この主張を検証したところ、`src/keystore/apiKeyStore.test.ts`が実際に存在し、注入されたフェイク`WebAuthnClient`に対して`createApiKeyStore`を運動させ、実際に重要なビジネスロジック（永続化の有効化/復元/無効化）をカバーしていることを確認した。
- 証拠: `src/keystore/webauthn.ts:1-6`（記載された根拠）。`src/keystore/apiKeyStore.test.ts`（消費側がフェイク経由でテストされていることを確認）
- 影響: なし。問題なし、と明言する。
- 確信度: 確認済み

---

## 確認できなかったこと
- コミット後の`notesRepo.applyCommit`の`noteHistory`蓄積分岐（同一termIdに対する2回目以降の`applyCommit`呼び出し）が、間接的なテスト（`drive/sync.test.ts`等）で実際にどこまで検証されているかは行番号レベルで完全には突き合わせていない。直接のユニットテスト（`repositories/notes.test.ts`）が無いこと自体は確認済み。
- `docs/review/agents/02-visual-design.md`に記載されたデッドCSS・トークン迂回以外の他エージェント（1・3等）の報告内容は未参照。重複確認は指定された`02-visual-design.md`のみに対して行った。
- `.gitignore`やCI設定など、CSSの命名規則を将来強制する仕組み（stylelint等）が本当に存在しないかは`package.json`/設定ファイル一覧の確認までで、npm scriptsの実行結果までは確認していない。
- [1]のApp.tsx分割提案（`useSeedImport`/`useApiKeyAuth`抽出）は構造上安全に見えるという評価であり、実際に抽出してテストが通ることまでは検証していない（コード変更は本タスクの範囲外のため未実施）。
