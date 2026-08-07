# IT-Index アーキテクチャ

- 版: 1.1（2026-08-07。§1・§2・§4.2・§5・§6・§7・§8を実装に合わせて更新。図の骨格自体は1.0から維持）
- 前提: [要件定義書](./requirements.md) / [初期データ形式仕様](./seed-format.md)

図はすべて Mermaid。GitHub 上でそのまま描画される（アプリ本体でも Mermaid を使うので技術が一貫する）。

---

## 1. 全体構成

**自前のサーバーを持たない。** アプリが直接、利用者自身の資格情報で外部APIを呼ぶ。

**2026-07〜08の方針転換（版1.0からの主な変化）**:
- PC版は**Electronアプリ**として配布する（ブラウザのPWAではない）。Android版は**Capacitor**でネイティブアプリ化。GitHub Pagesでのブラウザ配信も引き続き可能（同じReactコードを`vite build`するだけ）だが、実機配布はGitHub Releaseのインストーラー(.exe)・APKが主
- AIは**Anthropic Claude固定ではなく、Claude/OpenAI/Geminiの3プロバイダを切り替え可能**にした（[ai-client.md §1.5](./ai-client.md)）
- 端末間同期は**Google Driveではなく、QRコードによるLAN直結ペアリングが主手段**になった（[manual-sync.md](./manual-sync.md)）。Drive経由の実装は残っているが休眠中（[drive-sync.md](./drive-sync.md)）

```mermaid
flowchart LR
    subgraph pc["PC版（Electron）"]
        UIP["画面<br/>React + TypeScript"]
        COREP["純関数コア<br/>正規化・スコア・マージ・索引分類"]
        DBP[("IndexedDB<br/>Dexie")]
        SAFE["safeStorage<br/>APIキー暗号化"]
    end

    subgraph android["Android版（Capacitor）"]
        UIA["画面<br/>同じReactコード<br/>コンポーネントのみ分岐"]
        DBA[("IndexedDB<br/>Dexie")]
        KEYSTORE["Android Keystore<br/>APIキー暗号化"]
    end

    subgraph ext["外部サービス（利用者自身の資格情報）"]
        AI["AIプロバイダ<br/>Claude / OpenAI / Gemini"]
        DRIVE["Google Drive<br/>休眠中"]
    end

    subgraph pages["GitHub Pages / GitHub Release（配信）"]
        SEED["seed/terms.json"]
        REL["インストーラー(.exe) / APK"]
    end

    UIP --> COREP --> DBP
    UIP -->|チャット／分配統合| AI
    UIP --> SAFE
    UIA -->|チャット／分配統合| AI
    UIA --> KEYSTORE
    UIP <-.QR・LAN直結ペアリング.-> UIA
    SEED -->|初回・version変更時| DBP & DBA
    DBP -.休眠中.-> DRIVE
    REL -.配布.-> pc
    REL -.配布.-> android

    style AI fill:#ffe6e6
    style DRIVE fill:#eeeeee
    style COREP fill:#e6f3ff
```

- 🔴 **赤 = 課金・通信が発生する境界。** 検索と閲覧はここを通らない
- 🔵 **青 = 純関数として切り出す部分。** 単体テストで固める対象
- **PC/Android間で直接やり取りするのはQRペアリング（LAN内HTTP）だけ。** サーバーも外部の仲介も無い（[manual-sync.md](./manual-sync.md)）

---

## 2. ER図

**同期対象かどうかが設計の要**なので、色で示す。

```mermaid
erDiagram
    terms ||--o| notes : "1用語に1件"
    terms ||--o{ asks : "聞かれた記録"
    chatSessions ||--o{ chatMessages : "会話の中身"
    chatSessions ||--o{ asks : "この会話で生まれた"
    terms ||--o{ chatSessions : "用語から開いた場合のみ"
    terms ||--o{ noteConflicts : "連携で競合した場合のみ"

    terms {
        string id PK "termから決定的に生成"
        string term "見出し語"
        string_array readings "読み（原則1要素）"
        string summary "初期説明（不変・AIは触らない）"
        string field "分野（seed-format §5 の一覧）"
        string_array tags "任意"
        string searchKey "正規化済み・事前計算"
        string_array readingKeys "正規化済み・事前計算"
        string origin "seed | ai"
        number createdAt
        number updatedAt
        number deletedAt "tombstone"
    }

    notes {
        string termId FK
        string body "AI補足テキスト（Markdown）"
        string_array diagrams "Mermaid文字列（テキストと分離）"
        number updatedAt
        string lastEditedBy "deviceId"
        object_array noteHistory "版・同期対象外"
    }

    asks {
        string id PK
        string termId FK
        string sessionId FK "nullならローカル検索確定由来"
        number at
        string deviceId
        string source "ai | search"
    }

    chatSessions {
        string id PK
        string termId FK "null可（AIで検索＝主題が語でない場合）"
        string subjectLabel "termId nullの時の入力文字列"
        number startedAt
        number lastActiveAt
        string status "open | committing | committed | declined"
    }

    chatMessages {
        string id PK
        string sessionId FK
        string role "user | assistant"
        string content
        number at
        boolean hidden "クイック質問の定型文なら非表示"
    }

    settings {
        string deviceId "この端末の識別子"
        string seedVersion "取り込み済みの版"
        string autoUpdateExistingTerms "askedOnly | all"
    }

    syncEvents {
        string id PK
        number at
        string peerDeviceId "相手の判別のみ・表示名は無い"
        string_array receivedTermIds
        string_array sentTermIds
    }

    noteConflicts {
        string id PK
        string termId FK
        number detectedAt
        string peerDeviceId
        object local "検出時点の自端末側の内容（不変）"
        object remote "検出時点の相手端末側の内容（不変）"
        string resolution "local | remote | merged | null"
        object merged "AI統合結果のキャッシュ"
        number resolvedAt
    }
```

`keyStore`（APIキーの暗号化保存）は`terms`等と関連を持たない独立テーブルのため上図には含めない。詳細は[data-layer.md §2.2](./data-layer.md)。

### 同期対象の区分

| テーブル | 同期（QR連携） | 理由 |
|---|---|---|
| `terms` | **しない**（例外あり） | 配信データ由来で全端末同じ。`version` で入れ替えるだけ |
| `notes` | **する** | **端末ごとに育つ唯一のデータ** |
| `asks` | **する** | 追記のみ。`id` で和集合。重み付けの計算元 |
| `chatSessions` / `chatMessages` | **しない** | 共有すべきは統合された結果であって、過程ではない |
| `settings` | **しない** | 端末固有 |
| `keyStore` | **しない** | APIキーの暗号化保存用（明示オプトイン時のみ1行）。PC版はElectron `safeStorage`、Android版はAndroid Keystoreで暗号化するため、他端末にコピーしても復号できない。詳細は [data-layer.md §2.2](./data-layer.md) |
| `syncEvents` / `noteConflicts` | **しない** | 連携そのものの記録・競合解決の作業用データで、端末ローカルの履歴 |

> **例外**: `origin: 'ai'` の語（初期データに無く、チャットから登録された語）は他端末に存在しないため、`terms` も同期対象に含める。削除（tombstone）も`origin`を問わず同期対象（[data-layer.md §2.1](./data-layer.md)相当。`core/syncTarget.ts`）。

**実装状況（2026-08-07）**: `mergeSnapshot()`（決定的マージ）は実装済み。**同期の主手段はQRコードによるLAN直結ペアリング**（`src/pairing/`・`src/manualSync/`。「ファイルでやり取りする」経路・共有フォルダ方式はいずれも廃止済み）。Drive経由の読み書き層（`src/drive/`）も実装済みだが休眠中（[drive-sync.md](./drive-sync.md)）。同じ語を両端末が独自に編集していた場合の競合解決は**PC版に一本化**（[requirements.md §5.5](./requirements.md)）。

### 設計上の要点

| 決定 | 理由 |
|---|---|
| **`summary` と `notes.body` を別テーブルに分ける** | 初期データを更新配信しても**AI補足が上書きされない**。構造で保証する |
| **`diagrams` を `body` と分ける** | Mermaid構文エラーが**テキストを巻き添えにしない**。構造で保証する |
| **`asks` にカウンタを持たず、ログで持つ** | カウンタは同期で壊れる（新しい方を採ると消える／合算すると二重計上）。ログの和集合なら**何度マージしても結果が同じ** |
| **`searchKey` / `readingKeys` を事前計算** | 検索のたびに正規化しない。**後から正規化ルールを変えると全件再計算が必要**なので最初に固める |

---

## 3. ユースケース図

```mermaid
flowchart TB
    U(("未経験の<br/>ITエンジニア"))

    subgraph free["通信なし・無料・無制限"]
        UC1["用語を引く"]
        UC2["用語詳細を読む"]
        UC3["選択した語を引く"]
        UC4["履歴を見る<br/>（重み付け／時系列）"]
    end

    subgraph paid["APIキーが必要・課金あり"]
        UC5["AIに聞く（チャット）"]
        UC6["会話を確定して<br/>補足に反映"]
        UC7["新規語を単語帳に登録"]
    end

    subgraph setup["初期設定"]
        UC8["APIキーを設定"]
        UC9["Driveと連携"]
        UC10["端末間で同期"]
    end

    U --> UC1 & UC2 & UC3 & UC4
    U --> UC5 & UC8 & UC9
    UC5 --> UC6
    UC6 --> UC7
    UC9 --> UC10

    style free fill:#e8f5e9
    style paid fill:#ffe6e6
```

**鍵が無くても緑の枠はすべて動く。** 審査員や初見の利用者が、何も設定せずに辞書として使える。

---

## 4. シーケンス図

### 4.1 検索 → チャット → 確定 → 分配統合

**このアプリの中核の流れ。**

```mermaid
sequenceDiagram
    actor U as 利用者
    participant S as 検索画面
    participant C as 純関数コア
    participant DB as IndexedDB
    participant CH as チャット画面
    participant AI as AIプロバイダ<br/>（Claude/OpenAI/Gemini）

    U->>S: 「MTU」と入力
    S->>C: normalize + score
    C->>DB: 全件取得（数百〜千件）
    DB-->>C: terms[]
    C-->>S: スコア順の候補
    Note over S: 通信ゼロ・課金ゼロ

    alt 求める語がある
        U->>S: 候補を選択
        S->>DB: notes を取得
        DB-->>U: 初期説明 ＋ AI補足 ＋ 図
    else 求める語がない
        S-->>U: 「該当なし」＋ [AIに聞く]
        U->>CH: ボタンを押す（明示的な操作）
        Note over CH,AI: ここから課金

        loop 何度でも
            U->>CH: 質問
            CH->>AI: メッセージ（thinking: disabled）
            AI-->>CH: 回答
            CH-->>U: 表示＋言及された用語をチップ表示
        end

        Note over CH,S: 取り込みはホーム画面の<br/>「まとめて単語帳に取り込む」のみ<br/>（2026-08-04改訂）

        U->>S: ホームで「取り込む」を押す
        S->>AI: 会話全体＋主題（明示）＋既存のAI補足<br/>「用語ごとに切り分けて統合せよ」
        AI-->>S: [{term, body, diagrams, isTerm, askedByUser}, ...]
        Note over S: 承認画面は無い（2026-07-30廃止）<br/>常に自動でDBへ反映される<br/>主題の語はaskedByUser判定に関わらず必ず候補にする（2026-08-06）

        S->>DB: 既知の語 → notes を更新
        S->>DB: 未知の語 → terms(origin:'ai') と notes を新規作成
        S->>DB: 分配先の全語に asks を1件ずつ追加
        S->>DB: chatSession を committed に
    end
```

**要点:**

- **検索は一切通信しない。** 課金の入口は `[AIに聞く]` ボタン1つだけ
- **対話中は `notes` を更新しない。** 取り込み時に1回だけ。繰り返し統合による劣化を防ぐ
- **取り込みはホーム画面からの明示的な操作のみ。** 自動では走らない（2026-08-04改訂）
- **`asks` は分配先の語ごとに立つ。** 重み付けの加算元がここ

### 4.2 同期（Drive経由・休眠中の実装）

> **この節はDrive同期（`src/drive/`）の設計であり、現在の主同期経路ではない。** 実際に使われているQRコードによるLAN直結ペアリングの流れは[manual-sync.md](./manual-sync.md)を参照。決定的マージ（`mergeSnapshot()`）自体はQR経路でも同じものを再利用しているため、下図の「マージ」「競合検出」の部分だけは両経路で共通の設計として読める。

```mermaid
sequenceDiagram
    participant A as 端末A
    participant D as Drive appDataFolder
    participant B as 端末B

    Note over A,B: 起動時

    A->>D: device-*.json を全件取得
    D-->>A: [device-A.json, device-B.json]

    loop 各ファイル
        A->>A: syncSchemaVersion 検証
        alt 検証NG
            A->>A: そのファイルをスキップ（他は続行）
        end
    end

    A->>A: mergeSnapshot(local, ...files)
    Note over A: 決定的マージ<br/>notes: updatedAtが新しい方<br/>asks: idで和集合<br/>削除: tombstone維持

    opt 同じ語が両端末で独自に更新された
        A->>A: 競合を検出（数件のみ）
        A-->>A: この端末/相手/AI統合案から選ぶ<br/>（承認画面ではなくConflictResolver画面。QR経路では選択操作はPC版限定）
        Note over A: 鍵が無ければAI統合の選択肢のみ使えない
    end

    A->>A: 1トランザクションで書き込み
    Note over A: 途中失敗なら丸ごとロールバック

    Note over A,B: 変更後（デバウンス）

    A->>D: device-A.json のみ書き込み
    Note over A,D: lastEditedBy が自分のものだけ<br/>他端末のファイルには触れない

    B->>D: device-*.json を全件取得
    D-->>B: 更新された device-A.json を含む
    B->>B: 同じ手順でマージ
```

**要点:**

- **各ファイルの書き手が1台だけ。** 取り合いが起きないので更新消失が構造的に発生しない
- **1ファイルが壊れても他は読める。** 端末ごとに分けたことの副次効果
- **AI補助は任意。** 鍵が無くても決定的マージだけで同期は完結する

### 同期ファイル（`device-*.json`）の構造

```json
{
  "syncSchemaVersion": 1,
  "deviceId": "...",
  "writtenAt": 1753300000000,
  "notes":  [ /* lastEditedBy が自分のものだけ */ ],
  "asks":   [ /* 自分の端末で発生したものだけ */ ],
  "aiTerms":[ /* origin:'ai' の語だけ。他端末に存在しないため */ ]
}
```

> ⚠️ **`syncSchemaVersion` は、初期データの `schemaVersion`（[seed-format.md](./seed-format.md) §1）とは別物。**
> 前者は同期ファイルの形式、後者は配信データの形式で、**独立して変わる**。実装で共通のバリデータを使い回さないこと。名前を分けてあるのはそのため。

---

## 5. 状態遷移図 — チャットセッション

**2026-07-30改訂**: 承認画面（`approving` 状態）は廃止済み（AI提案は確認なしに自動反映される）。さらに、自動トリガー（別用語のチャットを開いた／15分放置／起動時の放置セッション回収）も廃止し、確定操作は明示的なボタン実行のみにした。

**2026-08-04改訂**: 取り込み（確定）操作を**ホーム画面の「まとめて単語帳に取り込む」1箇所に集約**した。チャット画面の確定ボタンと、一時的に復活させていた起動時の自動確定は廃止した（理由は[requirements.md](./requirements.md) §5.3。要点は、APIキーがセッション限りの保持のため起動直後は必ず未認証で自動確定が必ず失敗すること）。

**2026-08-06追加**: 「登録しない」操作により`declined`状態を追加した。AIには登録を拒否する権限が無い代わりに、利用者が明示的に拒否できるようにするための状態（[requirements.md §5.3](./requirements.md)「登録を拒否する権利は利用者にある」）。会話は削除されない。

```mermaid
stateDiagram-v2
    [*] --> open: チャットを開始

    open --> open: メッセージ送受信<br/>（lastActiveAt を更新）

    open --> committing: 取り込み操作<br/>（まとめて／個別）
    open --> declined: 「登録しない」
    open --> committed: その語が削除された<br/>（取り込む対象が無いため閉じる）

    declined --> committing: 気が変わって取り込み直す
    declined --> declined: 30件上限の枝刈り対象<br/>（lastActiveAtが古い順にchatMessagesごと削除）

    committing --> committed: DBへ自動反映
    committing --> open: API呼び出し失敗<br/>（open のまま残し次回再試行）

    committed --> [*]

    note right of open
        この間 notes は更新しない。
        取り込むまでここに留まり続ける
        （履歴画面「取り込み履歴」タブに表示される）
    end note

    note right of committing
        処理は冪等
        2回確定しても
        補足が二重にならない
    end note

    note right of declined
        会話は削除しない。
        取り込み・再取り込みはいつでも可能
    end note
```

---

## 6. コンポーネント構成

**純関数として切り出す部分と、副作用を持つ部分の境界を明確にする。**

```mermaid
flowchart TB
    subgraph pure["純関数コア（副作用なし・Vitestで固める）"]
        N["normalize()<br/>かな統一・全半角・大小"]
        SC["score()<br/>2-gram Dice ＋ 加点"]
        M["mergeSnapshot()<br/>決定的マージ・競合検出"]
        W["computeWeights()<br/>減衰付きスコア"]
        KR["kanaRow.ts<br/>単語一覧の索引バケット分類"]
    end

    subgraph io["副作用を持つ層"]
        REPO["リポジトリ<br/>Dexie 経由の読み書き"]
        AICLI["AIクライアント<br/>3プロバイダ切り替え"]
        PAIR["ペアリング<br/>QR・LAN直結HTTP"]
        SYNCD["同期クライアント<br/>Drive API（休眠中）"]
        KEYP["鍵ストア（PC）<br/>Electron safeStorage"]
        KEYA["鍵ストア（Android）<br/>Android Keystore"]
    end

    subgraph ui["画面"]
        P1["検索・単語一覧"]
        P2["用語詳細"]
        P3["チャット"]
        P4["履歴<br/>（重み付け／時系列／<br/>連携履歴／取り込み履歴／競合選択）"]
        P5["設定・連携"]
    end

    P1 --> N & SC & KR
    P2 --> REPO
    P3 --> AICLI
    P4 --> W & REPO
    P5 --> KEYP & KEYA & PAIR & SYNCD
    PAIR --> M
    SYNCD --> M
    N & SC & M & W & KR --> REPO

    style pure fill:#e6f3ff
```

### なぜ純関数に切り出すのか

| 関数 | 単体テストで固める内容 |
|---|---|
| `normalize()` | `さーば`／`サーバ`／`ｻｰﾊﾞ` が同一キーに落ちる |
| `score()` | `サーバー`→`サーバ`、`TCP/PI`→`TCP/IP` が上位に来る／`1` で `一意` が上位に来ない |
| `mergeSnapshot()` | **同じスナップショットを2回マージしても結果が変わらない**（冪等性）／壊れたデータで既存を消さない／片方でしか編集していない場合を競合と誤検出しない |
| `computeWeights()` | **マージ順序を入れ替えてもスコアが一致する**（決定性）／たくさん聞いた語がその後聞かれなければ沈む |
| `kanaRow.ts` | 全語がいずれかのバケットに必ず入る（索引から抜け落ちない）／読みが無い語がいても例外にしない |

**これらは実機もAPIキーも要らずに検証できる。** 開発中の手戻りを最小化する要。

---

## 7. 画面遷移

**2026-08-07全面改訂**: 承認画面（`APPROVE`）は2026-07-30に廃止済み。トップナビ5項目（検索/履歴/単語一覧/連携/設定）はすべて対等な画面遷移で、モーダルは無い（`src/App.tsx`の`Screen`判別共用体がそのまま実装）。取り込みは検索画面の「取り込み待ち」一覧・履歴画面「取り込み履歴」タブからのみ行い、チャット画面自体に確定ボタンは無い。

```mermaid
flowchart LR
    HOME["検索<br/>（取り込み待ち一覧を含む）"]
    DETAIL["用語詳細"]
    INDEX["単語一覧<br/>（索引）"]
    CHAT["チャット"]
    HIST["履歴<br/>重み付け/時系列/連携履歴/<br/>取り込み履歴/競合選択"]
    SET["設定"]
    LINK["連携（QR）"]

    HOME -->|語を選択| DETAIL
    HOME -->|AIで検索| CHAT
    DETAIL -->|この語についてAIに聞く| CHAT
    DETAIL -->|語を選択して引く| HOME
    INDEX -->|語を選択| DETAIL
    CHAT -->|話題を変える| CHAT
    CHAT -->|戻る（取り込みはしない）| HOME
    HIST -->|語を選択| DETAIL
    HIST -->|取り込み履歴/競合選択の行| CHAT
    HOME <--> HIST
    HOME <--> INDEX
    HOME <--> SET
    HOME <--> LINK
    LINK -->|競合検出| LINK

    style CHAT fill:#ffe6e6
```

**チャット画面は全画面。** 上部に現在の主題（`SubjectContext`）をチップで固定表示する。「取り込み履歴」タブから取り込み済みの会話を開いた場合は閲覧専用（readOnly）で開く。**用語詳細・履歴からの遷移は「戻る」導線が遷移元を覚えている**（`from`パラメータ。検索/単語一覧/履歴のどこから来たかで「戻る」の宛先が変わる）。

---

## 8. 外部依存の一覧

| 依存 | 用途 | 無いとどうなるか |
|---|---|---|
| AIプロバイダ（Anthropic Claude / OpenAI / Gemini。いずれか1つを利用者が選択） | チャット・分配統合・競合のAI統合 | **AI機能のみ停止。辞書・検索・履歴・単語一覧は動く** |
| LAN（QRペアリング。外部サービスではない） | 端末間同期 | **同期のみ停止。単一端末では完全に動く** |
| Google Drive API | 端末間同期（休眠中の代替経路） | 使っていない。QR連携が使えない環境向けの将来の選択肢として実装のみ残す |
| GitHub Pages / GitHub Release | アプリ本体・初期データ・インストーラー/APKの配信 | 起動できない（配信元） |
| mermaid.js | 図の描画 | **図のみ表示不可。テキストは表示される**（別フィールドのため） |

**AI・Drive・LANのいずれも「無くても本体が動く」位置づけ。** 単一障害点にしない。

---

## 関連文書

- [要件定義書](./requirements.md) — なぜこの設計なのか
- [初期データ形式仕様](./seed-format.md) — `terms` に入るデータの形
