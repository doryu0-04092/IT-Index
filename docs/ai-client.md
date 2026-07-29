# AIクライアント設計

- 版: 2.2（2026-07-29）
- 前提: [要件定義書](./requirements.md) §5.3 / [アーキテクチャ](./architecture.md) §4.1 / [データ層設計](./data-layer.md)

## 0. この文書の目的

要件定義書 §5.3 には「チャット」「分配統合」の**流れ**は書かれているが、AIに渡す指示文（プロンプト）と、AIの出力をどう構造化データとして受け取るかは未確定だった。本文書がその契約を定める。実装は `src/ai/` 配下。

**2026-07-27 方針転換**: 当初は Claude（Anthropic API）専用の実装だったが、**特定のAIプロバイダに縛られない設計へ変更した。** 現在は Anthropic Claude / OpenAI / Google Gemini の3つを切り替えて使える（§1.5）。なお本文書中の「Claude」は方針転換前の名残として一部残っているが、実装は `AiClient` という共通インターフェース越しに書かれている。

---

## 1. 全体構成

```
src/ai/
  aiClient.ts       … プロバイダ非依存の共通契約（AiClient / AiMessage / AiRequest）
  errors.ts         … HTTPステータス→日本語エラー文言（要件定義書§5.7、プロバイダ非依存）
  providers/
    types.ts          … AiProvider 型・プロバイダ一覧（表示名・既定モデル名）
    claude.ts          … Anthropic Messages API 実装（実機で疎通確認済み）
    openai.ts          … OpenAI Chat Completions API 実装（未疎通。§6参照）
    gemini.ts          … Google Gemini API 実装（未疎通。§6参照）
    index.ts           … createProviderClient()（静的に選ぶ） / createDynamicAiClient()（実行時に選ぶ）
  prompts.ts        … システムプロンプト・メッセージ組み立て（プロバイダ非依存）
  parseDistribution.ts / parseMerge.ts … AI出力(JSON)の検証・パース（純関数、fetch非依存）
  chat.ts           … 通常のチャット往復（1ターン）
  distribution.ts   … 分配統合（提案 propose / 反映 apply の2段階）
  commitOrchestrator.ts … 確定オーケストレーション（§5）
  testSupport.ts    … テスト専用フェイク AiClient
```

`AiClient` はインターフェースとして切り出し、`chat.ts` / `distribution.ts` はこれを注入で受け取る（プロバイダの違いを一切知らない）。実際の認証器が要る WebAuthn（`src/keystore/webauthn.ts`）と同じ理由で、**実際のAPI呼び出しはテストできない**ため、フェイク実装（`src/ai/testSupport.ts`）を注入してオーケストレーション（メッセージ組み立て・DB書き込み・エラー処理）だけを単体テストする。

---

## 1.5 複数プロバイダ対応

### なぜプロバイダを切り替えられるようにしたか

もともとは「Claude Codeの定額プランで動かせないか」という検討から始まった（無料/定額で使いたいという動機）。結論としてClaude Codeの定額枠を第三者アプリから使うには、**Node.jsのサーバープロセスが要るClaude Agent SDK経由しかなく、これは「自前サーバーを持たない」という本アプリの根本方針と衝突する**ため見送った。代わりに「従量課金のAPIキーであればClaude Codeとは無関係に使える」という点を確認し、そこからさらに「Anthropicに限定する理由も無い」という流れで複数プロバイダ対応にした。

### 設計

`AiClient`（`aiClient.ts`）はプロバイダ非依存の共通インターフェース。3つの実装（`providers/claude.ts` / `openai.ts` / `gemini.ts`）がこれを満たす。プロンプト文字列・JSON解析（`prompts.ts`/`parseDistribution.ts`/`parseMerge.ts`）は元々プロバイダに依存しない作りだったため、**変更不要だった。**

各プロバイダのリクエスト形式は次のとおり違う（`providers/*.ts` に実装）:

| | Anthropic | OpenAI | Gemini |
|---|---|---|---|
| エンドポイント | `api.anthropic.com/v1/messages` | `api.openai.com/v1/chat/completions` | `generativelanguage.googleapis.com/.../generateContent` |
| 認証 | `x-api-key` ヘッダー | `Authorization: Bearer` ヘッダー | URLクエリパラメータ `?key=` |
| systemプロンプト | 専用フィールド `system` | `role:'system'` の1メッセージとして`messages`内に含める | 専用フィールド `systemInstruction` |
| AI発言のrole名 | `assistant` | `assistant` | `model`（他と違う） |

### 資格情報の持ち方（プロバイダ・モデル・APIキーの3点セット）

APIキーだけではどのプロバイダ向けか分からない（例えば`sk-...`から始まるキーがOpenAIかAnthropicかは自明ではない）ため、`AiCredential { provider, apiKey, model }` の3点セットで扱う（`src/keystore/apiKeyStore.ts`）。永続保存（`KeyStoreRecord`。[data-layer.md §2.2](./data-layer.md)）にも `provider`/`model` を平文で追加した（秘匿情報ではないため暗号化対象外）。

### 実行時のプロバイダ切り替え（`createDynamicAiClient()`）

`App.tsx` は起動時に一度だけ `AiClient` を作る（`createDynamicAiClient(getSessionCredential)`）。これは**呼び出しのたびに現在のセッション資格情報を読み直し**、該当プロバイダの実装へその場で振り分ける薄いディスパッチャ。利用者がAPIキー画面でプロバイダを変更しても、`chat.ts`/`distribution.ts`/`commitOrchestrator.ts` 側のクライアント参照を作り直す必要が無い。

### UI（`ApiKeyPrompt.tsx`）— 2段階フロー（2026-07-27設計）

モデル名を利用者に手入力させると、存在しないモデル名を打ち間違える事故が起きる。そこで**「接続確認」を経てから、実際に取得したモデル一覧をプルダウンで選ばせる**2段階にした。

```
①APIキー入力            ②モデル選択
┌─────────────┐        ┌─────────────┐
│ プロバイダ ▼   │        │ 接続できました    │
│ APIキー [    ] │  ──▶   │ モデル ▼ (一覧)  │
│ [接続を確認]   │        │ [設定]         │
└─────────────┘        └─────────────┘
     ↑ 失敗したらここに留まる（401等をそのまま表示）
```

1. **① 接続を確認**: 入力されたAPIキーで、そのプロバイダの「モデル一覧取得」APIを叩く（`listModelsForProvider()`）。**この呼び出し自体がAPIキーの疎通確認を兼ねる**——無効なキーなら401などのエラーがここで返り、次の画面には進まない
2. **② モデル選択**: 取得できたモデルIDをプルダウンに列挙する。**自由入力ではなく選択式にすることで、存在しないモデル名を打ち間違える余地を無くした。** 一覧が空だった場合（フィルタが効きすぎた等）のみテキスト入力にフォールバックする
3. 「APIキーを入力し直す」で①へ戻れる（プロバイダを間違えた場合など）

各プロバイダのモデル一覧取得エンドポイント:

| プロバイダ | エンドポイント | 絞り込み |
|---|---|---|
| Anthropic | `GET /v1/models` | 絞り込み不要（一覧全体がMessages API対応） |
| OpenAI | `GET /v1/models` | id が `gpt-`/`o1`/`o3`/`o4`/`chatgpt` で始まり、`whisper`/`embedding`等を含まないものだけに簡易フィルタ（完全ではない） |
| Gemini | `GET /v1beta/models` | `supportedGenerationMethods` に `generateContent` を含むものだけ（Google公式ドキュメント記載のフィールド） |

実ブラウザで動作確認済み: 偽のAPIキーで「接続を確認」→ 401エラーが表示され、②の画面には進まないことを確認した（`docs/ai-client.md` の実装時点ではOpenAI/Geminiの実キーでの確認はまだ。§6参照）。

---

## 2. チャット（`chat.ts`）

architecture.md §4.1 の「何度でも」ループの1回分。

- システムプロンプトは**毎ターン動的に組み立てる**（固定文字列ではない）。`CHAT_SYSTEM_PROMPT`（未経験者向けの説明を促す指示。JSON等の構造化出力は要求しない）に、後述する `SubjectContext` 由来の「現在の話題」ブロックを追加したものを `system` として送る
- 呼ぶたびに **セッションの全メッセージ履歴**を渡す（要約や間引きはしない。会話が長くなった場合のトークン節約は将来の課題。§6参照）
- 対話中は `notes` を一切更新しない（要件定義書 §5.3 の方針どおり）
- **ユーザーが実際に入力したテキスト（`ChatMessageRecord.content`）には、文脈付与のための文字列を一切混ぜない。** 文脈は常に `system` 側で完結させる（理由は後述）

### 文脈の自動付与（2026-07-28設計 → 2026-07-29改訂 → 2026-07-29 構造変更）

要件定義書 §5.3「[チャットの主題（SubjectContext）](./requirements.md)」に対応する実装。

#### これまでの経緯（設計判断の根拠として残す）

最初の実装は `sendChatTurn()` が `termLabel: string | undefined` を受け取り、**セッションの最初の1通だけ**ユーザーのメッセージ本文に文脈を prepend する方式だった。

1. **初版**: 「〇〇についての質問です。」と一文添えるだけの実装。利用者から「ローカル検索した用語について聞いているはずなのに、AIがどの用語について聞かれているか認識していない」という報告を受けた。原因は、チャット画面の表示（`「TCP/IP」について`）と、AIへ実際に送るメッセージ本文の内容が食い違っていたこと。
2. **改訂**: 「〇〇についての質問です。」＋質問文（例:「これはどういうもの？」）という組み合わせで、AIが「これ」をコマンドやエラーメッセージなど別の何かと誤読する実例が見つかった。話題の説明に加え、**指示語（これ・この等）の解決先を明示的に指定する一文**を追加して修正した。

この改訂で当該のケースは解決したが、**症状（指示語の誤読）に対する一文パッチ**にとどまっていた。根本原因——`termLabel` が「確定した用語」なのか「検索欄の生文字列」なのかを区別していないこと、AIが辞書側の既存定義（`summary`/`notes.body`）を一切参照していないこと——には触れておらず、次に別の状況（複数用語の比較、話題転換）で同種の誤読が起きるたびに、また一文パッチを重ねる構造だった。

**この一文パッチの積み重ね方式そのものをやめ、構造的な設計に置き換えることを決定した**（2026-07-29。実装はこれから。下記「現在の設計」参照）。

#### 現在の設計（2026-07-29決定。実装未着手）: `SubjectContext` → システムプロンプトへの動的合成

**この節は今後の実装が従うべき契約であり、`src/ai/chat.ts` はまだ旧方式（`termLabel` のメッセージ内容への prepend）のままである。** `termLabel?: string` を廃止し、`SubjectContext` を受け取るようにする（フィールド名は実装フェーズで確定する設計レベルの概念）：

```
SubjectContext =
  | { mode: 'term'; termId: string; label: string; field: Field; readings: string[];
      existingSummary: string | null; existingNoteBody: string | null }
  | { mode: 'free'; seedQuery: string | null }
```

- `mode: 'term'` は `termId` が確定している場合のみ生成できる（用語詳細画面からの開始、または検索結果一覧で利用者が用語を明示的に選んだ場合）。生成時に `TermsRepository`/`NotesRepository` から実際の `summary`・`field`・`readings`・`notes.body` を取得し、グラウンディング文脈として保持する
- `mode: 'free'` は `termId` が未確定の場合。`seedQuery`（検索欄の生文字列）は「確定した主題」としてではなく参考情報として保持する

`sendChatTurn()` はユーザーの発言（`userText`）に一切手を加えず、代わりに**毎ターン** `SubjectContext` から動的生成した文脈ブロックを `CHAT_SYSTEM_PROMPT` に追加して `system` として送る:

```
system = CHAT_SYSTEM_PROMPT
       + "\n\n---\n現在の話題:\n"
       + （term modeの場合）
           `${label}（分野: ${field}、読み: ${readings.join('/')}）\n`
           + (existingSummary ? `既存の初期説明:\n${existingSummary}\n` : '')
           + (existingNoteBody ? `既存のAI補足:\n${existingNoteBody}\n` : '')
           + `この対話中「これ」「この」等の指示語は、断りが無い限り「${label}」を指すものとして扱ってください。`
         （free modeの場合）
           seedQuery ? `利用者は検索で「${seedQuery}」を探していましたが、確定した用語ではありません。` : '(自由な質問)'
```

これにより：

- **会話履歴（`ChatMessageRecord.content`）が汚染されない。** 分配統合（`distribution.ts`）に渡る会話全体も、利用者が実際に書いた文章のまま残る
- **話題変更（`[話題を変える]`）は `SubjectContext` を差し替えるだけで対応できる。** 新しい状況が起きるたびに文言を継ぎ足す必要がない
- **既存の初期説明・AI補足を文脈として渡せる。** 辞書に既に登録済みの内容と矛盾する回答が生成されるリスクを構造的に下げる（従来の `termLabel` 方式には無かった情報源）
- `AiClient`/`AiRequest`（`aiClient.ts`）の `system` は元々リクエスト単位のフィールドであり、プロバイダ実装（`providers/*.ts`）側の変更は不要

これ/この問題への一文は、この「現在の話題」ブロックの末尾の一文として残る（指示語の解決先を明示する必要性自体は変わらない）。変わったのは**渡し方**（メッセージ内容への一回限りの文字列連結 → システムプロンプトへの毎ターン動的合成）であり、指示語の扱い自体を今回変えたわけではない。

**教訓**: プロンプトに文脈を自然文で足すだけでは、話題の説明と実際の指示語の解決は別問題。日本語の指示語（これ・それ・この等）を含む質問文が続く場合は、「これ＝〇〇」という解釈を明示的に指示しないとAI側が別の解釈をし得る。ただし、その指示文言を**どこに何回貼るか**を場当たり的に決めると、新しい状況のたびに同種の対応が必要になる——渡し方自体を構造化することが、パッチの繰り返しを止める根本対応になる。

具体的な文言の回帰ケース（このブロックが無いとどう誤読するか、の具体例を含む）は [prompts.md](./prompts.md) に記録する。

---

## 3. 分配統合（`distribution.ts`）

2段階に分離してある。**DBへの書き込みは `applyDistribution()` だけが行う**（承認前に書き込まれることが構造的に無いようにするため）。

### 3.1 `proposeDistribution()` — AI呼び出し＋承認前プレビューの組み立て

1. セッションの全メッセージ + `DISTRIBUTION_INSTRUCTION` を Claude に渡す
2. 出力（JSON配列）を `parseDistributionResponse()` で検証
3. `isTerm: false` の項目は最初から除外する（要件定義書§5.3「2段の絞り込み」の1段目）
4. `makeTermId()` で既存語かどうかを判定し、**辞書に無い語（新規登録になる語）は `askedByUser: false` なら除外する**（要件定義書§5.3「新規登録は、利用者が明示的に尋ねた語だけ」。2026-07-29追加）。既存語への更新はこの絞り込みの対象外——`askedByUser` の値に関わらず処理を続ける
5. 残った各項目について
   - **既存語かつ既存の `notes.body` が空でない** → 「統合」プロンプト（`MERGE_SYSTEM_PROMPT`）で追加のAI呼び出しを行い、既存本文と新しい本文を1つに統合する
   - それ以外（新規語、または既存語だが本文が空）→ AIが起こした `draftBody` をそのまま使う
6. 統合呼び出しが失敗・出力不正だった場合は `draftBody` にフォールバックする（**統合の失敗で分配統合全体を止めない**）

この時点では **DBには一切書き込まない**。戻り値の `DistributionProposal` を承認画面に表示する想定。

### 3.2 `applyDistribution()` — 承認後の書き込み

- 承認された `termId` の集合を受け取り、その分だけ `notes` を更新（新規語は `terms` も作成）、`asks` を1件ずつ追加、最後に `chatSessions` を `committed` にする
- `commitSession()` 自体は冪等（既存実装済み）

### 3.3 分配統合とマージの呼び出し回数

1回の確定で Claude API は **1（分配統合） + 統合が必要な語の数** 回呼ばれる。既存語への言及が多い会話ほど呼び出し回数が増える。コスト面での上限は現状無い（§5参照）。

---

## 4. JSON契約

### 4.1 分配統合の出力（`parseDistribution.ts`）

```json
[
  {
    "term": "TCP/IP",
    "isTerm": true,
    "askedByUser": true,
    "readings": ["ティーシーピーアイピー"],
    "field": "ネットワーク",
    "draftBody": "単独で読んで理解できる完結した説明文（Markdown）",
    "diagrams": ["Mermaid文字列"]
  },
  { "term": "今日の天気", "isTerm": false, "diagrams": [] }
]
```

- `isTerm: false` の項目は `term` と `diagrams` のみ（`readings`/`field`/`draftBody`/`askedByUser` は要求しない）
- `askedByUser`（2026-07-29追加）: `isTerm: true` の項目には必須。利用者自身がその語について明示的に尋ねたかどうか。辞書に無い語（新規登録）はこれが `false` だと候補から除外される（`distribution.ts`。要件定義書§5.3参照）。既存語への更新には影響しない
- `field` は seed-format.md §5 と同じ24分類の一覧でバリデーションする（`FIELDS` を再利用）
- コードフェンス（` ```json ... ``` `）で包まれていても剥がして解釈する

### 4.2 統合（マージ）の出力（`parseMerge.ts`）

```json
{ "body": "統合後の説明文", "diagrams": ["Mermaid文字列"] }
```

---

## 4.3 AI新規登録語には「初期説明」欄が無い（2026-07-27決定）

`terms.summary` は origin:'ai' の語では **`null`** にする（空文字ではない）。理由:

- `summary`（初期説明）は「本人が用意する、思い出す用の簡潔な説明」であり（要件定義書§5.2）、書き手は明示的に「本人」。AIが書いた文章をここに入れると、この欄の不変性・出自の意味が崩れる
- したがって AI新規登録語には**初期説明という概念自体が存在しない**。空文字で埋めるのではなく、欄そのものが無いことを型で表す（`TermRecord.summary: string | null`）
- 用語詳細画面では、`summary === null` の場合 **`notes.body`（AI補足）だけを本文として表示する**。①初期説明／②AI補足の2段構成（要件定義書§5.2の図）は、AI新規登録語では②のみになる

実装: `src/repositories/terms.ts` の `buildTermRecord()` が `summary: string | null` を受け取り、`src/ai/distribution.ts` の `applyDistribution()` は新規語登録時に `summary: null` を渡す。

---

## 5. 確定オーケストレーション（`commitOrchestrator.ts`）

architecture.md §5 の状態遷移図（`open → committing → approving → committed`）のうち、**`open → committing → approving` までを実装する。** `approving → committed`（承認・DB書き込み）は担当しない——`applyDistribution()` を呼ぶのは承認画面UI（`src/ui/pc/ApprovalScreen.tsx`。実装済み）の役目であり、`createCommitOrchestrator()` はどんな経路でも**DBに一切書き込まない**。「分配は必ず承認画面を挟む」（要件定義書§5.3）を構造として強制するため。

4つのトリガーすべてに対応する:

| # | トリガー | 対応するメソッド |
|---|---|---|
| ① | 別の用語のチャットを開いた | `triggerCommit(sessionId)` |
| ② | 最終操作から15分経過 | `noteActivity(sessionId)` を呼ぶたびにタイマーを引き直す。既定15分（`timeoutMs`で変更可） |
| ③ | 明示的な確定操作 | `triggerCommit(sessionId)`（①と同じ実装） |
| ④ | 起動時に検出（15分以上前から放置） | `recoverStaleSessions()`。`chatRepo.findStaleOpenSessions()` を使って一括で確定処理へ回す |

AI呼び出し（`proposeDistribution()`）が失敗した場合は `onError` を呼ぶだけで、セッションの状態は変更しない（`committing --> open` に相当。次回のトリガーで再試行される）。

**未配線（このオーケストレーター自体はテスト済み）**: `noteActivity()`（トリガー②・15分無操作）を `ChatScreen` のメッセージ送受信から呼ぶ配線だけがまだ無い。`onProposalReady`（承認画面へ）・`recoverStaleSessions()`（起動時）は `App.tsx` に配線済み（[ui-pc.md](./ui-pc.md)）。

### テスト時の注意: fake-indexeddb と `vi.useFakeTimers()` は併用できない

`fake-indexeddb` は内部で `setTimeout` を使ってイベントディスパッチをシミュレートしている。Vitestの `vi.useFakeTimers()` でグローバルな `setTimeout` を差し替えると、DB操作そのものがハングする（`beforeEach` の `new ItIndexDB()` すら返ってこなくなる）。そのため `commitOrchestrator.test.ts` は実タイマー＋短い `timeoutMs`（数十ms）で代用している。DBを触るテストで時間経過をシミュレートする場合は同じ手法を使うこと。

---

## 6. 未決定・要検討

- **OpenAI・Geminiは実キーでの疎通確認ができていない**（このドキュメントを書いた時点では手元に有効なAPIキーが無かったため）。`providers/openai.ts`/`providers/gemini.ts` はドキュメント上のリクエスト・レスポンス形式に基づいて実装したのみ。特にブラウザから直接叩いた場合のCORS対応状況は未確認（Anthropicは確認済み。`anthropic-dangerous-direct-browser-access`ヘッダーで許可されることを実機確認済み）
- **`PROVIDERS`の`defaultModel`（`gpt-4o` / `gemini-2.0-flash`）は、モデル一覧取得が失敗・空だった場合のフォールバック表示にのみ使う値**（§1.5の②参照）。通常のフローではモデル一覧APIから実際に取得したIDを選ぶため、この既定値が古くなっていても実害は小さい
- **OpenAIのモデル一覧フィルタが粗い**（id のプレフィックス・部分文字列によるヒューリスティック）。実際のOpenAIアカウントで一覧を取得し、チャット非対応モデルが混入していないか・逆に有効なモデルを誤って除外していないか未検証
- **分配統合の出力に `readings`/`field` を含める設計は本実装で追加した拡張**（要件定義書にはAI出力の詳細スキーマが無かったため）。新規語の登録に必須なので追加した
- **トークン・コストの上限が無い**: チャット履歴は毎ターン全量を送り、分配統合＋統合呼び出しの回数にも上限が無い。長い会話や既存語への言及が多い確定では呼び出し回数・コストが増える。§6非機能要件「費用の目安」との整合は未検証
- **複数用語にまたがる比較質問（例:「AとBの違いは」）へのグラウンディングは未対応**: `SubjectContext` は現状 `term`（単一 `termId`）/`free` の2モードのみで、複数 `termId` への同時グラウンディングは設計対象外にした（要件定義書§5.3参照）。将来対応する場合は `SubjectContext` に配列型のモードを追加する形が想定される

---

## 7. ネットワーク/CORS失敗の扱い（2026-07-29改善）

`translateApiError()`（`src/ai/errors.ts`）はHTTPステータスコード前提の日本語翻訳であり、`fetch()`自体が**reject**する失敗（CORSブロック・オフライン・DNS失敗等。典型的には`TypeError: Failed to fetch`）はこの翻訳の対象外だった。`Response`が存在しない以上`AiApiError`のコンストラクタに到達する経路が構造的に無く、未翻訳の英語エラーがそのまま利用者に表示されていた。

**症状として何が起きるか**: 「APIキーが間違っている」ような表示にならず、`Failed to fetch`という技術的な英語がそのまま出る。日本語話者の利用者からは原因不明の失敗にしか見えず、「認証がよく失敗する」という報告の一部はこれが正体である可能性が高い（`docs/ui-pc.md`バグ8参照）。

**対応**: `src/ai/networkError.ts`に`fetchOrTranslateNetworkError()`を新設し、3プロバイダ（`claude.ts`/`openai.ts`/`gemini.ts`）の全`fetch()`呼び出し（`send()`・モデル一覧取得の両方、計6箇所）をこれ経由に統一した。`fetch()`がreject（ネットワークレベルの失敗）した場合のみ「AIサービスに接続できませんでした（ネットワークの問題、またはブラウザ・拡張機能による通信制限の可能性があります）。」に変換する。`res.ok`判定〜`AiApiError`によるHTTPステータス別翻訳は従来どおり変更していない（resolve後の処理には触れない）。

**未確認のまま残る点**: OpenAI・GeminiのAPIがブラウザからの直接呼び出し（Anthropicの`anthropic-dangerous-direct-browser-access`ヘッダーに相当するもの）を実際にCORSで許可するかどうかは、このドキュメント作成時点で実キーによる疎通確認ができておらず未確認（§6既存の記載どおり）。今回の改修によって、**もし実際にCORSで弾かれていたとしても、少なくとも利用者には分かりやすい日本語で失敗が伝わるようになった**（原因の切り分けはしやすくなったが、CORS自体の可否はまだ実機検証待ち）。

---

## 関連文書

- [要件定義書](./requirements.md) — §5.3 チャット・分配統合の方針
- [アーキテクチャ](./architecture.md) — §4.1 シーケンス図
- [データ層設計](./data-layer.md) — リポジトリ層・鍵ストア
- [プロンプト設計・回帰ケース集](./prompts.md) — 個々のプロンプト文言の契約と回帰ケース
