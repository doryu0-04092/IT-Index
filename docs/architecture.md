# IT-Index アーキテクチャ

- 版: 1.0（2026-07-24）
- 前提: [要件定義書](./requirements.md) / [初期データ形式仕様](./seed-format.md)

図はすべて Mermaid。GitHub 上でそのまま描画される（アプリ本体でも Mermaid を使うので技術が一貫する）。

---

## 1. 全体構成

**自前のサーバーを持たない。** ブラウザが直接、利用者自身の資格情報で外部APIを呼ぶ。

```mermaid
flowchart LR
    subgraph browser["ブラウザ（PWA）"]
        UI["画面<br/>React + TypeScript"]
        CORE["純関数コア<br/>正規化・スコア・マージ"]
        DB[("IndexedDB<br/>Dexie")]
        SW["Service Worker<br/>オフライン"]
    end

    subgraph pages["GitHub Pages（静的配信）"]
        APP["アプリ本体"]
        SEED["seed/terms.json"]
    end

    subgraph ext["外部サービス（利用者自身の資格情報）"]
        CLAUDE["Claude API<br/>Sonnet 5"]
        DRIVE["Google Drive<br/>appDataFolder"]
    end

    UI --> CORE
    CORE --> DB
    SW -.オフライン時.-> UI
    APP --> UI
    SEED -->|初回・version変更時| DB
    UI -->|チャット／分配統合| CLAUDE
    DB <-->|同期| DRIVE

    style CLAUDE fill:#ffe6e6
    style DRIVE fill:#ffe6e6
    style CORE fill:#e6f3ff
```

- 🔴 **赤 = 課金・通信が発生する境界。** 検索と閲覧はここを通らない
- 🔵 **青 = 純関数として切り出す部分。** 単体テストで固める対象

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
        string sessionId FK
        number at
        string deviceId
    }

    chatSessions {
        string id PK
        string termId FK "null可（自由チャット）"
        number startedAt
        number lastActiveAt
        string status "open | committed"
    }

    chatMessages {
        string id PK
        string sessionId FK
        string role "user | assistant"
        string content
        number at
    }

    settings {
        string deviceId "この端末の識別子"
        string driveToken
        string seedVersion "取り込み済みの版"
    }
```

### 同期対象の区分

| テーブル | Drive同期 | 理由 |
|---|---|---|
| `terms` | **しない**（例外あり） | 配信データ由来で全端末同じ。`version` で入れ替えるだけ |
| `notes` | **する** | **端末ごとに育つ唯一のデータ** |
| `asks` | **する** | 追記のみ。`id` で和集合。重み付けの計算元 |
| `chatSessions` / `chatMessages` | **しない** | 共有すべきは統合された結果であって、過程ではない |
| `settings` | **しない** | 端末固有。**APIキーは含めない** |

> **例外**: `origin: 'ai'` の語（初期データに無く、チャットから登録された語）は他端末に存在しないため、`terms` も同期対象に含める。

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
    participant AI as Claude API

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

        Note over CH: 確定トリガー<br/>①別用語のチャットを開く<br/>②15分経過<br/>③明示的な確定

        CH->>AI: 会話全体＋既存のAI補足<br/>「用語ごとに切り分けて統合せよ」
        AI-->>CH: [{term, body, diagrams, isTerm}, ...]
        CH-->>U: 承認画面（分配先と内容を表示）
        U->>CH: 承認

        CH->>DB: 既知の語 → notes を更新
        CH->>DB: 未知の語 → terms(origin:'ai') と notes を新規作成
        CH->>DB: 分配先の全語に asks を1件ずつ追加
        CH->>DB: chatSession を committed に
    end
```

**要点:**

- **検索は一切通信しない。** 課金の入口は `[AIに聞く]` ボタン1つだけ
- **対話中は `notes` を更新しない。** 確定時に1回だけ。繰り返し統合による劣化を防ぐ
- **分配は必ず承認を挟む。** AIの切り分けミスが直接データを壊さない
- **`asks` は分配先の語ごとに立つ。** 重み付けの加算元がここ

### 4.2 同期

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

    opt 同じ語が両端末で更新された
        A->>A: 競合を検出（数件のみ）
        A-->>A: AIに統合案を依頼 → 承認 → 適用
        Note over A: 鍵が無ければこの段は飛ばす
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

```mermaid
stateDiagram-v2
    [*] --> open: チャットを開始

    open --> open: メッセージ送受信<br/>（lastActiveAt を更新）

    open --> committing: ① 別用語のチャットを開いた
    open --> committing: ② 最終操作から15分経過
    open --> committing: ③ 明示的な確定操作
    open --> committing: ④ 起動時に検出<br/>（lastActiveAt が15分以上前）

    committing --> approving: AIが分配案を返す
    committing --> open: API呼び出し失敗<br/>（open のまま残し次回再試行）

    approving --> committed: 利用者が承認
    approving --> open: 却下（会話は残る）

    committed --> [*]

    note right of open
        この間 notes は更新しない
    end note

    note right of committing
        処理は冪等
        2回確定しても
        補足が二重にならない
    end note
```

**④が重要。** タブを閉じられると15分タイマーは動かないため、**起動時に未確定セッションを回収する**。これが無いと会話が永久に `open` のまま残る。

---

## 6. コンポーネント構成

**純関数として切り出す部分と、副作用を持つ部分の境界を明確にする。**

```mermaid
flowchart TB
    subgraph pure["純関数コア（副作用なし・Vitestで固める）"]
        N["normalize()<br/>かな統一・全半角・大小"]
        SC["score()<br/>2-gram Dice ＋ 加点"]
        M["mergeSnapshot()<br/>決定的マージ"]
        W["computeWeights()<br/>減衰付きスコア"]
    end

    subgraph io["副作用を持つ層"]
        REPO["リポジトリ<br/>Dexie 経由の読み書き"]
        AICLI["AIクライアント<br/>Claude API"]
        SYNC["同期クライアント<br/>Drive API"]
        KEY["鍵ストア<br/>WebAuthn PRF + AES-GCM"]
    end

    subgraph ui["画面"]
        P1["検索"]
        P2["用語詳細"]
        P3["チャット"]
        P4["確定・承認"]
        P5["履歴（重み付け／時系列）"]
        P6["設定（鍵・Drive・端末）"]
    end

    P1 --> N & SC
    P2 --> REPO
    P3 --> AICLI
    P4 --> AICLI & REPO
    P5 --> W
    P6 --> KEY & SYNC
    SYNC --> M
    N & SC & M & W --> REPO

    style pure fill:#e6f3ff
```

### なぜ純関数に切り出すのか

| 関数 | 単体テストで固める内容 |
|---|---|
| `normalize()` | `さーば`／`サーバ`／`ｻｰﾊﾞ` が同一キーに落ちる |
| `score()` | `サーバー`→`サーバ`、`TCP/PI`→`TCP/IP` が上位に来る／`1` で `一意` が上位に来ない |
| `mergeSnapshot()` | **同じスナップショットを2回マージしても結果が変わらない**（冪等性）／壊れたデータで既存を消さない |
| `computeWeights()` | **マージ順序を入れ替えてもスコアが一致する**（決定性）／たくさん聞いた語がその後聞かれなければ沈む |

**これらは実機もAPIキーも要らずに検証できる。** 開発中の手戻りを最小化する要。

---

## 7. 画面遷移

```mermaid
flowchart LR
    HOME["検索"] --> DETAIL["用語詳細"]
    HOME -->|該当なし＋ボタン| CHAT["チャット"]
    DETAIL -->|AIに聞く| CHAT
    DETAIL -->|語を選択して引く| HOME
    CHAT -->|確定| APPROVE["承認画面"]
    APPROVE --> DETAIL
    HOME <--> HIST["履歴"]
    HIST --> DETAIL
    HOME <--> SET["設定"]

    style CHAT fill:#ffe6e6
    style APPROVE fill:#ffe6e6
```

**チャット画面は全画面。** 上部に会話中に言及された用語をチップで固定表示し、確定時の分配先のプレビューとする。

---

## 8. 外部依存の一覧

| 依存 | 用途 | 無いとどうなるか |
|---|---|---|
| Claude API | チャット・分配統合・競合解決 | **AI機能のみ停止。辞書・検索・履歴は動く** |
| Google Drive API | 端末間同期 | **同期のみ停止。単一端末では完全に動く** |
| GitHub Pages | アプリと初期データの配信 | 起動できない（配信元） |
| mermaid.js | 図の描画 | **図のみ表示不可。テキストは表示される**（別フィールドのため） |

**AI と Drive はどちらも「無くても本体が動く」位置づけ。** 単一障害点にしない。

---

## 関連文書

- [要件定義書](./requirements.md) — なぜこの設計なのか
- [初期データ形式仕様](./seed-format.md) — `terms` に入るデータの形
