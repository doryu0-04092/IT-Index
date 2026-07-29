# PC版UI設計

- 版: 2.7（2026-07-29）
- 前提: [要件定義書](./requirements.md) §5.1〜§5.4 / [データ層設計](./data-layer.md) / [AIクライアント設計](./ai-client.md)

## 0. この文書の目的

PC版（マウス・キーボード前提）のUI実装を記録する。**Android版は別途、独立したコンポーネント一式として後で作る方針**（PC版と同一コンポーネントをレスポンシブ対応で使い回さない）。そのため `src/ui/pc/` に隔離してある。`src/ui/shared/` はプラットフォーム非依存のロジック（フック等）専用。

---

## 1. 実装済み画面

```
src/ui/pc/
  SearchScreen.tsx          … 検索（要件定義書§5.1）
  TermDetailScreen.tsx      … 用語詳細（要件定義書§5.2）
  ApiKeyPrompt.tsx          … プロバイダ選択・モデル名・APIキー入力（セッションのみ／永続保存の両対応。フルスクリーン・設定モーダルの両方から再利用）
  ChatScreen.tsx            … チャット（要件定義書§5.3）
  TermPicker.tsx            … 「話題を変える」で使う用語ピッカー（検索と同じscore()を再利用。2026-07-29）
  ApprovalScreen.tsx        … 分配統合の承認画面（要件定義書§5.3）
  HistoryScreen.tsx         … 重み付け／時系列ビュー（要件定義書§5.4。1画面にタブで統合。2026-07-29）
  SettingsModal.tsx         … 設定モーダル（APIキー変更・パスキー管理。2026-07-29）
src/ui/shared/
  useDebouncedValue.ts       … 入力デバウンス（§6非機能要件「150ms程度」）
```

`src/App.tsx` が画面遷移（`search` / `detail` / `chat` / `approve` / `history`）と、`src/ai/commitOrchestrator.ts`（確定オーケストレーション）・シード取り込みを統括する。ルーティングライブラリは使わず、単純な `useState` によるビュー切り替え。設定モーダル（`SettingsModal`）は画面遷移とは独立に、`App.tsx` の `settingsOpen` フラグで開閉する（どの画面の上にも重ねて開ける）。

### SearchScreen

- `termsRepo.getAll()` で全件を一度読み込み、入力のたびに `score()`（純関数）でスコアリング・並べ替え
- **`[AIに聞く]` はクエリがある間は常に表示する。「結果0件のときだけ表示」ではない。** 要件定義書§5.1「順位付けは必ず何かを返すので候補ゼロは発生しない」を実データ（3510語）で検証したところ、長めのクエリはほぼ必ずどれかの語と部分一致してしまい、`results.length === 0` になる場面が実質発生しないことを確認した（詳細は§3）
- 検索結果の各行に**用語を明示的に選んでAIに聞く**導線を用意する。行を選ばずに `[AIに聞く]` を押した場合は、`termId` を確定させない自由モードで開始する（用語モード／自由モードの区別は要件定義書§5.3「チャットの主題（SubjectContext）」、[ai-client.md §2](./ai-client.md)参照）。**最上位候補への自動ひも付けはしない**——スコアはあくまで並べ替え用であり、どの語について聞きたいかの確定には使わない
- 上部に「重み付けビュー」「時系列ビュー」への導線を常設（`HistoryScreen`の初期タブを指定して開く）
- シード取り込み状況（例:「最新です（3510語）」）は検索欄の直下に `seedStatus` prop として表示する（2026-07-29。従来はヘッダーに表示していたが、検索欄との視覚的な結び付きを優先して移動した。ヘッダー側は `.app-header h1` の下余白を広げ、見た目の間隔を変えないようにしてある）

### TermDetailScreen

- `summary`（初期説明）は `null` の場合セクション自体を出さない（AI新規登録語。[ai-client.md §4.3](./ai-client.md)）
- `notes.body` は現状プレーンテキスト表示（`white-space: pre-wrap`）。**Markdown・Mermaidの描画は未実装**。図（`diagrams`）は生のMermaid文字列を`<pre>`でそのまま表示し、「未描画」と明示する
- 「この語についてAIに聞く」から `termId` 付きのチャットセッションを開始できる

### ChatScreen / ApiKeyPrompt

- APIキーが未設定（`getSessionCredential() === null`）の間は `ApiKeyPrompt` を表示する。プロバイダ選択→APIキーで接続確認→取得したモデル一覧から選択、という2段階フロー（[ai-client.md §1.5](./ai-client.md)）
- **既定はセッションのみ保持**（要件定義書§5.6層3）。「この端末に保存する」を明示的にチェックした場合のみ、WebAuthn PRFで暗号化して永続保存する（層2。`src/keystore/apiKeyStore.ts` の `enablePersistence()`）。保存に失敗してもセッションでは使えるようフォールバックする

### 入口認証バナー（`App.tsx`。2026-07-28設計）

保存済みの資格情報がある場合、**サイトに入った直後・ヘッダー直下に「パスキーで認証」ボタンを常時表示する。** 自動で裏側で復元を試みる方式はやめた（理由は§3バグ5）。

- 起動時に `apiKeyStore.hasPersistedCredential()` で「保存済みかどうか」だけを確認する（この呼び出しはWebAuthnを要さない。復号はしないため）
- 保存済みなら `.auth-banner` を表示し、**「パスキーで認証」ボタンを利用者が押した瞬間に** `apiKeyStore.tryRestore()` を呼ぶ（＝実際のWebAuthn呼び出しは必ずクリックというユーザー操作の中で行う）
- 「今は使わない」で今回のセッションだけバナーを消せる（次回起動時はまた出る）
- 復元に成功すると `keyReady` が立ち、以後 `ChatScreen` は `ApiKeyPrompt` を出さずそのままチャットできる
- 送信のたびに `sendChatTurn()` を呼び、セッションの全履歴を選択中のAIプロバイダへ渡す（`src/ai/chat.ts`）
- 「この会話を確定する」ボタンは `commitOrchestrator.triggerCommit(sessionId)` を呼ぶ（トリガー③）。成功すると `App.tsx` 側の `onProposalReady` が承認画面へ遷移させる（`ChatScreen` 自身は遷移先を知らない）
- 画面上部に現在の主題（`SubjectContext`）を示す表示を常設する。用語モードなら「『○○』について質問中」＋ `[話題を変える]`、自由モードなら主題を確定させない表現にする（要件定義書§5.3、[ai-client.md §2](./ai-client.md)）。チップには用語名・分野程度のみ表示し、`notes.body` 全文は表示しない（モデルへ送る文脈と画面表示は分離する）
- `[話題を変える]`（自由モードでは「用語を選ぶ」）は `TermPicker.tsx` を開く。選択すると `App.tsx` の `startChat()` をそのまま呼ぶ——既存のトリガー①（別の用語のチャットを開いた＝前の会話は終わり）がそのまま「話題変更時は自動で確定してから切り替える」を満たすため、専用の分岐は追加していない（利用者に別途確認は挟まない。安全性の根拠は要件定義書§5.3参照）

### ApprovalScreen

- `DistributionProposal.proposedTerms` を一覧表示。チェックボックスは既定で全選択、新規語には「新規語」バッジ
- 承認 = `applyDistribution()` を呼ぶ唯一の経路。却下は何もせず戻るだけ（会話は `open` のまま残る。要件定義書§5.3）

### HistoryScreen（2026-07-29: 1画面に統合）

従来は `HistoryWeightedScreen` / `HistoryTimelineScreen` の2コンポーネントに分かれていたが、**同じデータ（`asksRepo.getAllOrdered()` と用語情報）を別の切り口で見るだけ**なので、1つの画面にタブ切り替えで統合した。データ取得は1回だけ行い、`weightedRows`/`timelineRows`をそれぞれ`useMemo`で導出する。

- 重み付けタブ: `computeWeights()`（純関数）の結果に用語情報を突き合わせて表示
- 時系列タブ: `at` の新しい順に並べ替えて表示
- `initialView` propで開始タブを指定（検索画面の「重み付けビュー」「時系列ビュー」ボタンから連動）

### SettingsModal（2026-07-29）

画面左下に固定表示する歯車アイコン（`.settings-gear`）から開くモーダル。画面遷移とは独立しており、どの画面の上からでも開ける。

- 「AIプロバイダ・APIキー」セクション: 現在の設定（プロバイダ・モデル）を表示し、「変更」ボタンで`ApiKeyPrompt`をモーダル内に埋め込んで再利用する（`backLabel="← 設定に戻る"`で戻り先の文言を変える）
- 「この端末への保存」セクション: 保存済み（`hasPersistedCredential()`）の場合のみ表示。「パスキーで認証」（`tryRestore()`を呼ぶ）・「この端末の保存を削除」（`disablePersistence()`）を提供
- ヘッダーの入口認証バナー（§1後述）と役割が重なる部分（パスキー認証）があるが、バナーは「サイトに入った直後、まだ認証していない」状態専用、モーダルは「認証状態を確認・変更したいとき、いつでも」という使い分け

### 確定オーケストレーションの配線（`App.tsx`）

- トリガー①（別用語のチャットを開いた）: `startChat()` 内で、既にアクティブなセッションがあれば新セッション作成前に `triggerCommit()` を呼ぶ
- トリガー③（明示的な確定操作）: `ChatScreen`の「確定する」ボタン
- トリガー④（起動時のstaleセッション回収）: `App.tsx`のマウント時 `useEffect` で `recoverStaleSessions()` を1回呼ぶ
- トリガー②（15分無操作）は `commitOrchestrator.noteActivity()` を呼ぶ配線が**まだ無い**（`ChatScreen`からの呼び出し未実装）

---

## 2. 未実装

- Android版UI一式
- 設定モーダルでのDrive/手動同期・端末管理（APIキー・パスキー管理は実装済み。§1 SettingsModal参照）
- Markdown/Mermaidの実際の描画
- Service Worker（オフライン動作）
- トリガー②（15分無操作での自動確定）の`ChatScreen`側配線
- 複数の分配案が同時に `approve` 待ちになった場合の扱い（`recoverStaleSessions()`が複数セッションを一括処理すると、`onProposalReady`が連続で呼ばれ、画面遷移が最後の1件で上書きされる。実運用でstaleセッションが複数残ることは稀だが、未対応のまま）

---

## 3. 実ブラウザ検証で見つかった実バグ（重要）

**単体テスト・型チェックだけでは検出できなかった3つのバグ**を、Playwright + 実データ（3510語）でブラウザを実際に操作して発見した。単体テストは個々の関数の正しさは保証するが、**複数のuseEffectが絡む起動時の競合状態や、実際のAPI呼び出し失敗時の状態遷移は再現できない**、という教訓。

### バグ1: `SettingsRepository.get()` の非アトミックな check-then-add

`get()` は「無ければ作る」という実装で、`db.settings.get('singleton')` → 無ければ `db.settings.add(...)` という2手順だった。**React 18 StrictMode は開発時にeffectを意図的に2回実行する**ため、`App.tsx` の起動時 `useEffect`（`importSeed()` を呼ぶ）が2回同時に走り、両方が「まだ無い」と判定して2回目の `add()` が主キー衝突で失敗する競合が実際に発生した。

**症状**: シード取り込み自体は成功する（`3510語`と表示される）のに、検索結果が常に0件になる。原因の特定には `page.evaluate()` でIndexedDBを直接覗く必要があった（DOM上の表示だけでは「なぜ0件か」が分からなかった）。

**修正**: `get→add` を1つの `db.transaction('rw', ...)` に包み、`add` を冪等な `put` に変更（`src/repositories/settings.ts`）。回帰テストを追加済み（`settings.test.ts`「does not throw when get() is called concurrently」）。

**教訓**: StrictModeは「開発時だけ発生する二重実行」を模擬してくれる。**これで表面化するバグは、複数タブを同時に開いた場合など、本番でも起こり得る実際の競合状態**なので、「開発時だけの誤検知」として無視してはいけない。

### バグ2: `SearchScreen` が用語一覧を1回しか読み込まない

`SearchScreen` は `termsRepo.getAll()` をマウント時に1回だけ呼ぶ実装だった。**初回起動時、`SearchScreen` はシード取り込みの完了を待たずにマウントされ得る**ため、空のDBを読んで `terms: []` のまま固定される（取り込み完了後に再読み込みする仕組みが無いため）。

**修正**: `App.tsx` 側で、シード取り込みが確定する（成功・失敗どちらでも）まで `SearchScreen`/`TermDetailScreen` 自体を描画しないようにした（`seedSettled` フラグ）。

### バグ3: AI呼び出し失敗時、送信済みメッセージが画面から消える

`ChatScreen.handleSend()` は `sendChatTurn()` 成功時にだけ `setMessages(...)` で画面を更新する実装だった。`sendChatTurn()` は**ユーザーの発言をDBへ保存してからClaude APIを呼ぶ**（`src/ai/chat.ts`: `appendMessage`→`claude.send`の順）ため、API呼び出しが失敗（実機検証では実際に401エラーで確認）してもユーザーの発言自体はDBに残る。しかし画面側は失敗時に再読み込みしないため、**送信したはずのメッセージが一瞬で消えたように見える**（実際は消えておらず、次に何か送るかリロードするまで表示されないだけ）。

**発見の経緯**: 実際に無効なAPIキーでチャット送信を行い、`APIキーが違います。設定を確認してください。`という翻訳済みエラー（要件定義書§5.7の実装）が正しく出ることを確認する過程で、送信したメッセージが表示から消えていることに気づいた。

**修正**: `finally` ブロックで成否に関わらず `chatRepo.getMessages(sessionId)` を読み直すようにした（`src/ui/pc/ChatScreen.tsx`）。

### バグ4: 日本語入力（IME）の変換確定Enterが送信として誤爆する

`ChatScreen` のテキストエリアは `onKeyDown` で `Enter && !shiftKey` を「送信」と判定していた。**日本語入力では、漢字変換の候補を確定するときにもEnterキーが使われる**（`compositionstart`〜`compositionend`の間）。`isComposing` を見ずに判定していたため、**長い文章を書いている途中、変換を確定するたびに未完成の文章が送信されてしまっていた。**

**発見の経緯**: 利用者から「AIへの質問を書いている段階で自動的に確定される」という報告を受けた。まず`noteActivity()`（15分無操作トリガー）が原因という仮説が出たが、`grep`で調べたところ**`noteActivity()`はUIのどこからも呼ばれておらず、そもそもタイマー自体が仕掛けられていない**ことを確認し、その仮説を除外した。次に実際のコード（`ChatScreen`の`onKeyDown`）を読み直し、IMEとの衝突に気づいた。

**修正**: `e.nativeEvent.isComposing` を判定に追加し、変換確定中のEnterを無視するようにした（`src/ui/pc/ChatScreen.tsx`）。Playwrightで`compositionstart`〜`isComposing:true`のEnter〜`isComposing:false`のEnterを実際に発火させ、前者では送信されず・後者では送信されることを確認済み。

**教訓**: 日本語（や中国語・韓国語）入力を想定するテキスト入力では、Enterキーでの送信判定に必ず`isComposing`のチェックが要る。英語入力だけでテストしていると気づけない。

### バグ5: 保存したはずのAPIキーが、次に使おうとすると「未設定」に戻る

`navigator.credentials.get()`（WebAuthnでのパスキー認証）は、認証情報を取得できない場合に**`resolve(null)`ではなく`reject`する**仕様である。にもかかわらず `src/keystore/webauthn.ts` の `getPrfOutput()` はtry/catchを持たず、「取得できなければnullが返る」という誤った前提で書かれていた。

さらに `App.tsx` は起動時の `useEffect` 内で `apiKeyStore.tryRestore()` を**ユーザー操作を伴わずに自動で**呼んでいた。`navigator.credentials.get()` はユーザー操作（クリック等）を伴わない自動呼び出しをブラウザに拒否されることがあり、その場合も例外を投げる。この2つが重なった結果、**ページを開いた瞬間の自動復元が失敗し、しかも失敗が未捕捉の例外（unhandled rejection）として握りつぶされ、利用者には何のエラーも表示されないまま「保存したはずのキーが使えない」状態になっていた。**

**発見の経緯**: 利用者から「APIキーを保存して、パスキーも接続しているのに、また質問すると"APIキーが設定されていません"と出る」という報告を受けた。保存時に問題が無かったこと（パスキー登録は成功している）から、復元（`tryRestore`）側の問題と判断し、`navigator.credentials.get()`の失敗時の挙動（reject であって resolve(null) ではない）を再確認して原因を特定した。

**修正**:
1. `getPrfOutput()` に try/catch を追加し、失敗時は契約どおり `null` を返すようにした（`src/keystore/webauthn.ts`）
2. **設計を変更**: 起動時の自動復元をやめ、**サイトに入った直後にヘッダー直下へ「パスキーで認証」ボタンを表示し、ユーザーの明示的なクリックの中で`tryRestore()`を呼ぶ**方式にした（`App.tsx`の入口認証バナー。上記参照）。ユーザー操作を起点にすることで、ブラウザ側の拒否を避ける
3. `hasPersistedCredential()` を新設し、復号せずに「保存済みかどうか」だけを確認できるようにした（バナー表示の判定に使用。WebAuthnを要さないので失敗しない）

**教訓**: WebAuthnの`get()`/`create()`は失敗時に例外を投げる。「エラー時はnullを返す想定」で設計・実装しても、呼び出しにtry/catchが無いと未捕捉例外として静かに失敗し、利用者には何も伝わらない。また、ページ読み込み時の自動呼び出しは、ユーザー操作を要求するブラウザAPIとは根本的に相性が悪い。

### バグ6: 認証前に自動実行される「放置セッション回収」が、消えないエラー表示を残す

起動時の `useEffect` で `commitOrchestrator.recoverStaleSessions()`（トリガー④。15分以上放置された`open`のチャットセッションを確定処理に回す）を無条件に実行していた。**この処理はAPIキーの認証（`keyReady`）が済む前、ページを開いた直後に走る。** その時点でAPIキーが無いのは正常な状態（まだ認証していないだけ）なのに、`proposeDistribution()`が`AiClient.send()`で「APIキーが設定されていません」という例外を投げ、`commitOrchestrator`の`onError`経由で`App.tsx`の`globalError`にセットされる。

**さらに問題を悪化させていた点**: `globalError`は**一度セットされると消える仕組みが無かった。** そのため、後から利用者がパスキー認証に成功しても、認証前の一瞬に出たこのエラーだけがヘッダーに居座り続け、「認証したのにまだエラーが出ている」ように見えていた。

**発見の経緯**: 利用者から「パスキーで認証したのに"確定処理に失敗しました: APIキーが設定されていません"と表示される」という報告を受けた。実際のコンソールログ（利用者提供）のスタックトレースが `recoverStaleSessions → commit → proposeDistribution → send()` を示しており、認証フロー（`handleAuthenticate`）とは無関係の、起動時の自動処理から発生していることを確認した。

**修正**:
1. `recoverStaleSessions()` の呼び出しを `keyReady` が true になるまで待つようにした（`App.tsx`）。dispose用の`useEffect`とは別の`useEffect`に分離し、認証未了の間はそもそも実行しない
2. `globalError` を閉じるボタン（✕）を追加し、利用者が明示的に消せるようにした（一般的な安全策として。他の予期しないエラーが今後同じように居座ることを防ぐ）

**教訓**: 「起動時に自動実行する処理」は、その処理が依存する前提条件（ここではAPIキーの認証）が整う前に走ってしまわないか必ず確認する。また、一度セットしたエラー状態を消す手段（自動クリア、または手動の閉じるボタン）を用意しないと、原因と無関係なタイミングのエラーが後々まで誤解を招き続ける。

### バグ7: 何も送信していない放置チャットが、勝手にAI呼び出し・新規語登録へ進んでしまう

「AIに聞く」ボタンを押した**瞬間**（まだ何も入力していない段階）に `chatRepo.createSession()` がDBへ`open`状態のセッションを作成する（`App.tsx`の`startChat()`）。ここでチャット画面を閉じて一言も送信せずに離脱すると、中身が空のセッションがDBに残り続ける。

15分以上経過後、次にアプリを開いて認証すると、`recoverStaleSessions()`（トリガー④）が**メッセージの有無を確認せずに**すべての放置セッションを拾い上げ、無条件に`proposeDistribution()`→AI呼び出しへ回していた。会話内容が空のままAIに「分配統合してください」という指示だけが送られるため、AIが文脈もなく何かを捏造して返し、`onProposalReady`が呼ばれて**利用者の操作なしに承認画面へ強制遷移**していた（同じ問題はトリガー①〈別語のチャットを開いた時に前のセッションを自動確定する処理〉にも共通していた）。

なお、承認画面に遷移しても実際のDB書き込み（`applyDistribution`）は利用者の明示的な承認クリックが必要なため、無断で用語が登録されることはない。ただし「検索していないのに勝手にAIが動いて新規語登録の画面が出る」という体験自体が、利用者からは「勝手に検索・登録しようとしている」ように見える。

**発見の経緯**: 利用者から「検索していないのに勝手にAIを使って検索するような動作になっている。新規用語を勝手に登録する方向に動いている」という報告を受けた。`commitOrchestrator.ts`と`chatRepo.createSession()`を読み直し、セッションがチャット開始ボタンのクリック時点（メッセージ送信より前）に作成されること、`recoverStaleSessions()`がメッセージ件数を一切見ていないことを確認した。

**修正**: `commitOrchestrator.ts`の`commit()`内で、対象セッションのメッセージが0件なら AI呼び出し自体をスキップし、`chatRepo.commitSession()`を直接呼んで`committed`扱いにするようにした（確定する内容が無いため）。これは`triggerCommit`・`recoverStaleSessions`の両方が通る共通経路なので、1箇所の修正で両トリガーに効く。回帰テストを追加済み（`commitOrchestrator.test.ts`「recoverStaleSessions skips stale sessions with no messages instead of calling the AI」）。

**教訓**: 「セッションが存在する」ことと「セッションに確定すべき会話内容がある」ことは別物。DBレコードの有無だけでなく、中身（メッセージ件数）を見て判断しないと、UIの都合で早期に作られた空のレコードが自動処理の対象に紛れ込む。

### バグ8: API・パスキー認証の失敗が多い（2026-07-29調査・複数原因）

利用者から「API・パスキー周りの認証の失敗が結構多い」という報告を受け、コードを読み直して裏付けのある原因を洗い出した。バグ5・6（WebAuthnの`get()`失敗の扱い）とは別の、これまで指摘していなかった原因が複数見つかった。

**原因1（最重要）: パスキー保存時にWebAuthn認証儀式が2回連続で走る設計だった**

`apiKeyStore.ts`の`enablePersistence()`は、`registerPasskey()`（`navigator.credentials.create()`）で登録した**直後に**、暗号鍵の元になるPRF出力を得るため`getPrfOutput()`（`navigator.credentials.get()`）という**別の**認証儀式を必ずもう一度呼んでいた。利用者は1回目のプロンプト（登録）が成功した時点で「完了した」と誤解しやすく、2回目のプロンプトに気づかず放置・キャンセルすると「鍵の導出に失敗しました」で失敗する。しかもこの時点で1回目の`create()`によるパスキー自体は認証器（Windows Hello等）に**既に作成済み**のため、再度「保存する」を試みるたびに使われない重複パスキーが増えていく構造だった。

**修正**: `create()`呼び出し時に`prf.eval`を渡すよう変更した（`src/keystore/webauthn.ts`の`registerPasskey()`）。対応ブラウザでは登録と同時にPRF出力まで直接得られるため、2回目の`getPrfOutput()`呼び出し自体が不要になり、**1回の認証儀式で保存が完結する**。この最適化に対応しない（古い）ブラウザでは、従来どおり`getPrfOutput()`を呼ぶフォールバックに自然に落ちる（`apiKeyStore.ts`の`enablePersistence()`: `prfOutputFromCreate ?? (await webauthn.getPrfOutput(credentialId))`）。フォールバック経路が使われる場合に備え、「この端末に保存する」チェックを入れると画面上に「2回連続で認証を求められることがある」旨の案内を追加した（`ApiKeyPrompt.tsx`）。

**原因2: ネットワーク/CORS失敗が未翻訳の英語エラーとして表示される**

`fetch()`自体がreject（CORSブロック・オフライン等）した場合、`Response`が存在しないためHTTPステータス前提の`AiApiError`/`translateApiError()`に到達できず、`Failed to fetch`のような技術的な英語がそのまま表示されていた。日本語話者の利用者からは「APIキーが違うのでは」と誤解されやすく、報告された「認証の失敗」の一部の正体である可能性が高い。詳細と修正内容は[ai-client.md §7](./ai-client.md)を参照。

**原因3（軽微）: `registerPasskey()`の`create()`にtry/catchが無かった**

バグ5で`getPrfOutput()`側（`get()`）には対応済みだったが、同じくreject挙動を持つ`create()`側は未対応のままだった。呼び出し元（`ApiKeyPrompt.handleSubmit`）で一段上位ではcatchされ未捕捉例外にはならないものの、翻訳されない生の`DOMException`メッセージ（英語）がそのまま出ていた。`webauthn.ts`の`registerPasskey()`にtry/catchを追加し、日本語の案内文に変換した。

**教訓**: 「1回の呼び出し失敗をどう扱うか」（バグ5）を直しても、「そもそも複数回の認証儀式を要求する設計」自体が失敗の温床になり得る。UIの体感上の失敗（「認証がよく失敗する」）は、単一のバグではなく複数の小さな原因が積み重なっていることが多く、個々の再現手順だけでなくコード全体を読み直して裏付けを取る調査が必要だった。

### バグ9: 設定側では「登録済み」と表示されるのに、開いたままのチャット画面では使えない

利用者から「パスキーで登録したAPIキーが登録表示されているのに使用できない」という報告を受けた。

**原因**: `ChatScreen.tsx`が、APIキーが使える状態かどうかを`hasKey`という**この画面専用のローカル状態**として持っていた（`useState(() => getSessionCredential() !== null)`）。この初期化はマウント時に一度しか実行されない。一方`App.tsx`側にも同じ意味の状態`keyReady`が別に存在し、ヘッダーの入口認証バナーや設定モーダルでの認証はこちらだけを更新する。

チャット画面をAPIキー未設定のまま開くと（`hasKey=false`のまま）画面内に埋め込みの`ApiKeyPrompt`が表示され続ける。ここで**画面を閉じずに**別経路（ヘッダーバナー・設定モーダル）でパスキー認証すると、`App.tsx`の`keyReady`は正しく`true`になり設定側は「登録済み」と表示されるが、`ChatScreen`の`hasKey`は誰にも更新されないため`false`のまま取り残される。結果、設定は成功しているのにチャット画面だけ「APIキーが必要です」の入力画面を表示し続けた。

逆方向のバグも同居していた: `ChatScreen`内の埋め込み`ApiKeyPrompt`で**初めて**APIキーを設定した場合、`onSet`はローカルの`setHasKey(true)`しか呼ばず、`App.tsx`の`keyReady`には一切伝播していなかった。

**修正**: 「同じ事実を2箇所に別々に持つ」という構造自体をやめた。`ChatScreen`から`hasKey`ローカル状態を削除し、`App.tsx`の`keyReady`をpropとして受け取るだけにした（`keyReady: boolean`）。あわせて`onKeyReady: () => void`propを新設し、`ChatScreen`内の`ApiKeyPrompt`の`onSet`をこれに差し替えた。これにより、認証がどの画面から行われても`App.tsx`の`keyReady`という1箇所だけが更新され、`ChatScreen`は次の再レンダリングで必ず正しい状態を反映する。

**教訓**: 「同じ意味の状態を複数のコンポーネントがそれぞれ別のローカル state として持つ」設計は、片方だけ更新される経路が必ずどこかに生まれる。真実源は1箇所に集約し、他はpropとして受け取るだけにする。

---

## 関連文書

- [要件定義書](./requirements.md) — §5.1 検索・§5.2 用語詳細の設計方針
- [データ層設計](./data-layer.md) — `TermsRepository`/`SettingsRepository`
- [AIクライアント設計](./ai-client.md) — `summary: null` の扱い
