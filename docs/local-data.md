# ローカルデータ層（Claude Code 連携）設計

- 版: 1.0（2026-07-30）
- 前提: [要件定義書](./requirements.md) / [データ層設計](./data-layer.md) / [手動同期設計](./manual-sync.md) / [プロンプト設計](./prompts.md)

## 0. この文書の目的

利用者が既に契約している Claude Code / Claude を「ローカルファイルを編集するAI編集者」として使えるようにする機能の設計。アプリ自身はAIを内蔵しない。AIが編集できるデータ構造とドキュメントを持ち、API経由の既存機能（AI検索・AIチャット）とファイル編集の両方が同じデータを見る。

```
利用者 → 自然言語指示 → Claude Code → 規定ファイル編集 → アプリが読み込み → 表示
```

**やらないこと**（設計時に明示的に却下した方向）:

- Electron / Tauri 化。ローカルサーバーの新設
- アプリから Claude Code CLI を呼び出すこと——ブラウザ SPA からローカルプロセスは起動できない。技術的に不可能で、実現には常駐サーバーの新設が必要になる
- `summary`（初期説明）の書き換え機能。不変ルール（[types.ts](../src/types.ts) の `TermRecord.summary` コメント）は維持する

## 1. 前提となるデータ構造

このアプリは localStorage ではなく **IndexedDB（Dexie）** にデータを保存している（[db.ts](../src/db.ts)）。本機能はその上に、輸送手段として「Claude Code が編集しやすいファイル構成」を追加する。

既存の `src/manualSync/`（[manual-sync.md](./manual-sync.md)）の「共有フォルダ方式」が使う **File System Access API** をそのまま利用する。輸送する中身の形式だけが異なる（既存: 機械向けの `device-*.json` 1本。本機能: `data/terms.json` + `data/notes/*.md`）。

## 2. フォルダ構成

利用者が選んだ任意のローカルフォルダ（Dropbox等の同期フォルダでもよい）の直下に、次の構成を自動生成する。

```
選んだフォルダ/
├ data/
│   ├ terms.json            … 変更データ層。origin:'ai' の語のみ。シードと同一形式
│   ├ notes/
│   │   ├ <termId>.md       … 語ごとの詳しい説明。ファイル名 = normalize(term)
│   │   └ ...
│   └ pending/
│       ├ <termId>.md       … 未確定チャットの書き出し（参照専用。アプリは取り込まない）
│       └ ...
├ AI_EDIT_GUIDE.md          … Claude Code 向け編集規約（アプリが自動生成）
└ backups/
    └ <timestamp>/          … 取り込み・初期化の直前に自動退避
```

### 層の分離

| 層 | 実体 | 変更可否 |
|---|---|---|
| 初期データ層 | アプリ内蔵 `public/seed/terms.json`（3510語、`origin:'seed'`） | 不変。本機能の対象外 |
| 変更データ層 | 選択フォルダの `data/terms.json` + `data/notes/*.md`（`origin:'ai'` の語＋任意の語のノート） | Claude Code / API 双方から変更される |

`data/terms.json` に `origin:'seed'` の語を含めないのは意図的な設計——含めないことで「ファイルに存在しないものは書き換えられない」という構造によって `summary` 不変ルールを守っている。

## 3. `data/terms.json` の形式

既存のシード形式（[seed-format.md](./seed-format.md)）と**完全に同一**。Claude Code が既に把握している形式をそのまま使い回す。

```json
{
  "schemaVersion": 1,
  "version": "2026-07-30",
  "terms": [
    { "term": "CORS", "readings": ["シーオーアールエス"], "summary": "（不変。書き換えない）", "field": "セキュリティ", "tags": ["Web"] }
  ]
}
```

実装: [src/localData/termsFile.ts](../src/localData/termsFile.ts)。検証は `validateSeedFile()`（[validateSeed.ts](../src/core/validateSeed.ts)）を流用せず、専用の `validateLocalTermsFile()` を用意している——理由は §7 参照。

## 4. `data/notes/<termId>.md` の形式

```markdown
---
term: CORS
field: セキュリティ
summary: 異なるオリジン間の通信をブラウザが制御する仕組み。
updatedAt: 2026-07-30T12:00:00.000Z
---

ここが編集対象（Markdown）。理解のための詳しい説明を書く。

```mermaid
graph LR
  A --> B
```
```

- front matter（`---` で囲まれた先頭部分）は**参照専用**。Claude Code が対象語を把握するために書き出すが、編集しても取り込み時に無視される
- front matter 以降が `NoteRecord.body`。` ```mermaid ` フェンスは `NoteRecord.diagrams[]` として別枠に持つ既存スキーマに合わせ、書き出し時は本文の後ろに順番で付け直す（往復で安定させる）
- 実装: [src/localData/noteFile.ts](../src/localData/noteFile.ts)

## 5. 取り込み（ファイル → IndexedDB）

自動で走る。`importSeed`（初期データ層）の後に実行する（[App.tsx](../src/App.tsx) の起動時 `useEffect`）。

1. `data/terms.json` の `lastModified`（File System Access API から取れるファイルの更新時刻）を、`settings.localTermsLastModified` と比較する。変化が無ければ何もしない（3510語規模の再パースを避ける）
2. `backups/<timestamp>/` へ現在の `data/` を退避する
3. `validateLocalTermsFile()` で検証。1件でも違反があれば **全件中止**（既存データを保持する）
4. **削除の安全弁**: ファイルから消えた `origin:'ai'` 語は tombstone（`deletedAt` セット）にする。ただし減少件数が `max(20, 既存件数の10%)` を超えたら取り込みを中止する（誤削除・書き込み途中のファイル読み取り対策）
5. 適用: 新規語は `origin:'ai'` で追加。既存語は `readings`/`field`/`tags` を更新し、**`summary` は既存値を保持する**（ファイル側の値は読み取らない）
6. `data/notes/*.md` を `notesRepo.applyCommit()` で適用する。対応する語が存在しない（`termId` が不明）ファイルはスキップし、結果に記録する

実装: [src/localData/importLocalData.ts](../src/localData/importLocalData.ts)、フォルダI/Oとの橋渡しは [src/localData/localFolderSync.ts](../src/localData/localFolderSync.ts) の `runLocalImportIfChanged()`。

## 6. 書き出し（IndexedDB → ファイル）と確定処理の順序

**「Claude Code の編集が既定で優先される」を、確定ボタンを押した瞬間の処理順序で実現する。**

```
確定ボタン
  ↓
① ファイルを取り込む（runLocalImportBeforeCommit）— Claude Code の編集を先に反映
  ↓
② AI要約処理・DB書き込み（commitOrchestrator.triggerCommit）
  ↓
③ ①②の結果をファイルへ書き出す（runLocalExport）
```

①を必ず②より先に行うため、②が上書きし得るのは「そのセッションが触れた語」に限られ、それ以外の Claude Code の編集は失われない。この順序により、旧設計案にあった「書き出し直前に `lastModified` を再確認して不一致なら中止する」という処理は不要になった（先に取り込むので失われるものが無い）。

実装: [App.tsx](../src/App.tsx) の `commitSessionWithLocalSync()`。フォルダが未設定の場合は①③とも何もしない（従来どおりDBのみで完結する）。

### 6.1 未確定チャットの書き出し（`data/pending/`）と、Claude Code処理完了の検知

上記①〜③は「確定ボタンを押した後」のフローだが、**確定前**のチャットのやり取り（ホームの「AIによる単語更新待ち」一覧に出ているもの）も Claude Code から処理できるよう、`data/pending/<termId>.md` として書き出す。front matter を持つ `data/notes/*.md` と違い、**このファイルはアプリが取り込まない完全な参照専用ファイル**——Claude Code はこの内容を読んで `data/terms.json`・`data/notes/<termId>.md` の方を編集する。

- 書き出しのタイミング: フォルダ接続直後・チャット画面を確定せずに離れた時・確定処理の完了直後（ベストエフォート。失敗してもチャット・確定処理自体は止めない）
- 対象はホームの一覧と同じ条件（`termId` に紐づき、メッセージ1件以上）。自由な質問（`termId: null`）は対象外

**Claude Codeは処理が終わったら `data/pending/<termId>.md` を自分で削除する**（`AI_EDIT_GUIDE.md` の指示）。アプリはこの削除を検知して、対応するチャットセッションを `committed` にする——確定ボタンを押さずに済み、確定ボタン経由のAPI要約が二重に走ることもない。

検知の仕組み: `ChatSessionRecord.pendingExportedAt`（一度でも書き出した時刻。未書き出しは `null`）を使う。書き出し前にファイルの有無を確認し、

- ファイルが**既にあれば**: 内容を最新化して上書き（通常の再書き出し）
- ファイルが**無く、`pendingExportedAt` も null**（＝まだ一度も書き出していない）: 新規に書き出し、`pendingExportedAt` を記録する
- ファイルが**無く、`pendingExportedAt` が設定済み**（＝以前は書き出していたのに消えている）: Claude Codeが処理を終えて削除したとみなし、書き戻さずセッションを `commitSession()` する

`pendingExportedAt` が無いと「まだ一度も書いていない（＝正常）」と「以前書いたのに消えている（＝処理完了の合図）」を区別できないため、この追跡フィールドが必須になる。

実装: [src/localData/pendingChatFile.ts](../src/localData/pendingChatFile.ts)（変換）、[src/localData/localFolderSync.ts](../src/localData/localFolderSync.ts) の `exportPendingChats()`（フォルダI/O・検知ロジック）、[src/repositories/chat.ts](../src/repositories/chat.ts) の `markPendingExported()`。

## 7. `validateSeedFile()` を流用しなかった理由

`data/terms.json` はシードと同一形式だが、検証は専用の `validateLocalTermsFile()`（[termsFile.ts](../src/localData/termsFile.ts)）を用意した。

理由: シードの `validateSeedFile()` は `summary` を必須（空文字は違反）とする。しかし変更データ層には、2026-07-29 以前に登録された `summary:null` の `origin:'ai'` 語が残っている場合がある（[types.ts](../src/types.ts) の `TermRecord.summary` コメント参照）。これをそのまま `validateSeedFile()` に通すと、**その1語のためにファイル全体の取り込みが恒久的に失敗し続ける**（検証失敗時は全件中止するため）。`validateLocalTermsFile()` は空文字の `summary` を許容し、取り込み時に `null` へ戻すことでこの問題を避けている。

## 8. 権限とタイミング

Chrome 122 以降の File System Access API は「毎回許可 / 今回のみ許可 / 拒否」の三択プロンプトになっており、「毎回許可」を選べば訪問をまたいで権限が持続する。**ページの再読み込みだけでは権限は失効しない**（失効するのはそのオリジンの全タブを閉じた後）。

- 起動時: `queryPermission()` のみ呼ぶ（ユーザー操作不要で呼べる）。`granted` なら自動取り込み。`prompt`/`denied` なら何もしない
- 設定画面の「今すぐ読み込む」ボタン: `requestPermission()` を呼ぶ（ユーザー操作起点が必須なため、ボタンクリックの中で行う）

実装: [LocalFolderPanel.tsx](../src/ui/pc/LocalFolderPanel.tsx)。

## 9. 初期化（初期データへのロールバック）

設定画面の「初期データに戻す」。`backups/` へ退避 → `origin:'ai'` の語を tombstone し対応するノートを空にする → `data/` を空の状態に戻す。

**既知の制限**: `asks`（質問履歴）は削除しない。`AsksRepository` に削除手段が無く、対象語が消えても重み付け計算に実害が無い（履歴が単に使われなくなるだけ）ため、この機能のために削除APIを新設するコストに見合わないと判断した。

実装: [localFolderSync.ts](../src/localData/localFolderSync.ts) の `resetToInitialData()`。

## 10. プロンプトの統一

`AI_EDIT_GUIDE.md`（Claude Code向け）と API 側システムプロンプト（`DISTRIBUTION_SYSTEM_PROMPT`/`MERGE_SYSTEM_PROMPT`、[prompts.md](./prompts.md)）が、品質基準（初心者向け・専門用語補足・概要と具体例・技術的正確性・詰め込みすぎない）について同じ文言を参照する。正本は [src/localData/editRules.ts](../src/localData/editRules.ts) の `buildQualityRules()`。

ファイル形式・編集可否など「ファイル編集特有」の指示（JSON構造、front matter、`summary`不変の注意書き）はここに含めない——API側には `data/terms.json` という概念自体が無いため。それらは `buildAiEditGuideFile()` にのみ書く。

## 11. AIチャットの確定操作をボタン実行のみにした理由

Claude Code のファイル編集が既定で優先されるためには、確定タイミングを利用者が制御できる必要がある。従来の自動トリガー（別用語のチャットを開いた／15分放置／起動時の放置セッション回収）は確定タイミングが予測不能で、書き出しのタイミングも予測不能になり、Claude Code の編集と衝突する窓を広げる。そのため2026-07-30、確定操作を明示的なボタン実行（`triggerCommit`）のみにした。確定していないセッションはホームの「AIによる単語更新待ち」一覧（`ChatRepository.getOpenSessions()`）に残る。

## 関連文書

- [要件定義書](./requirements.md)
- [手動同期設計](./manual-sync.md) — 既存の共有フォルダ方式（機械向け輸送）との関係
- [プロンプト設計・回帰ケース集](./prompts.md)
- [初期データ（シード）形式仕様](./seed-format.md)
