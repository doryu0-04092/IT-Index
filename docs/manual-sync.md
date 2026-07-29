# 手動同期（ファイル書き出し／QRコード／共有フォルダ）設計

- 版: 2.0（2026-07-27）
- 前提: [要件定義書](./requirements.md) §5.5 / [データ層設計](./data-layer.md) / [Drive同期クライアント設計](./drive-sync.md)

## 0. この文書の目的

2026-07-27、Google Cloud Console 側の運用負荷（未検証アプリのテストユーザー枠維持、審査対応など）を理由に、**端末間同期の主手段を Drive から「アカウント設定不要な同期手段」へ切り替えた**（要件定義書§5.5の方針転換メモ参照）。Drive同期のコードは削除せず休眠させてある（[drive-sync.md](./drive-sync.md) §5）。

**この切り替え・拡張がほぼノーコストで済んだ理由**: `mergeSnapshot()`（決定的マージ）・`SyncFile`形式・`buildOutboundSyncFile()`・`resolveConflict()`（AI競合解決）は元々**輸送手段に依存しない設計**だった（`src/sync/` に集約済み）。輸送手段ごとの違いは「ファイルの中身をどうやって相手に渡すか」だけであり、`src/manualSync/sync.ts` の `RawFile{name, content}` という共通の受け渡し形にさえ変換すれば、どの輸送方式からも同じマージロジックを呼べる。

現在3つの輸送手段を用意している。**どれか1つに絞る必要は無く、状況に応じて使い分けられる。**

| 手段 | 向いている場面 | アカウント設定 | 対応環境 |
|---|---|---|---|
| ファイル書き出し（§2） | 汎用・フォールバック | 不要 | PC・スマホ両方 |
| QRコード（§3） | その場で少量（1〜数語）を素早く | 不要 | カメラがあるPC・スマホ両方 |
| 共有フォルダ（§4） | 普段使いで手間を最小化したい | 不要（既存のDropbox等に乗る） | **PC版Chrome/Edgeのみ**（Android Chrome非対応） |
| PC中継（§5） | 共有フォルダ非対応端末（Android）を、それでも共有フォルダの恩恵に載せたい | 不要 | Android側はQR/ファイル書き出しと併用 |

---

## 1. 全体構成

```
src/sync/                共通ロジック（どの輸送手段からも使う）
  localSnapshot.ts        … buildLocalSnapshot()
  syncFile.ts              … buildOutboundSyncFile() / syncFileName()
  resolveConflict.ts       … AI競合解決（要件定義書§5.5の「同じ語の両端更新」）

src/manualSync/
  sync.ts                  … importSyncFiles() / exportOwnSyncFile() / exportFullSnapshot()（DOM非依存、テスト可能。全輸送手段が共通で使う）
  fileTransport.ts         … ①ファイル書き出し（File API直叩き、テスト対象外）
  qrCodec.ts                … ②QRの符号化/復号（DOM非依存、テスト可能）
  qrScanner.ts              … ②カメラ映像からの継続読み取り（getUserMedia、テスト対象外）
  folderTransport.ts        … ③共有フォルダ（File System Access API、テスト対象外）
```

`src/drive/sync.ts`（Drive版の `runSync()`）も同じ `src/sync/` の関数を呼ぶ。**同じマージロジックを全輸送手段で共有している**ため、Drive同期を将来有効化しても動作に差異は生まれない。

---

## 2. ①ファイル書き出し（`fileTransport.ts`）

### エクスポート

1. `exportOwnSyncFile(deps)` を呼ぶ → `{ name: 'device-<id>.json', content: '...' }` が返る
2. `downloadRawFile()` に渡すとブラウザの標準ダウンロードとして保存される
3. 利用者が任意の方法（メール、USBメモリ、クラウドストレージへの一時アップロード等）でファイルを別端末へ移す

### インポート

1. `<input type="file" multiple>` 等で他端末の `device-*.json` を1つ以上選ばせる
2. `readFilesAsRawFiles(fileList)` でテキストとして読み出す
3. `importSyncFiles(files, deps)` に渡す。**JSON構文エラー・`syncSchemaVersion`検証NGのファイルは読み飛ばして他は処理を続ける**（`skippedFiles` に記録）
4. 返ってきた `conflicts`（両端末で更新された語）はAI統合の対象として承認画面へ（`src/sync/resolveConflict.ts`。承認画面UI自体は未実装）

**1回のインポートで複数ファイルを一気に取り込める**（`importSyncFiles([fileA, fileB, ...])`）ので、3台以上の端末があっても手順は変わらない。

---

## 3. ②QRコード（`qrCodec.ts` / `qrScanner.ts`）

### v1のスコープ: 1枚のQRに収まる範囲だけ

**複数枚に分割する「アニメーションQR」（fountain codeで大きなデータを連続表示→合成デコードする方式）は実装しない。** 専用ライブラリが枯れていないうえ実装コストが高いため。1枚のQRの実用上の容量は数百〜3000バイト程度（誤り訂正レベルMで運用）。**日常的な1〜数語の更新には十分だが、初回同期やまとめ同期には向かない**（その場合はファイル書き出しに誘導する）。

### 符号化・復号（`qrCodec.ts`。DOM非依存でテスト済み）

- `encodeAsQrSvg(content)`: `qrcode` パッケージで **SVG文字列**として生成する（Canvas/DOM不要）。容量超過時は `{ ok: false, reason }` を返す
- `decodeQrFromImageData(data, width, height)`: `jsqr` パッケージへの薄いラッパー。RGBAピクセル配列を受け取りテキストを返す
- テストでは `qrcode` の `create()` が返すモジュール行列を自前でRGBAピクセルにラスタライズし、`decodeQrFromImageData` に通して**実際のエンコード→デコード経路を検証している**（`qrCodec.test.ts`）

### カメラでの読み取り（`qrScanner.ts`。ブラウザ専用、テスト対象外）

`startQrScan(videoElement, onDecode)` が `getUserMedia` でカメラ映像を取得し、`requestAnimationFrame` ループで毎フレーム `decodeQrFromImageData` に通す。QRが検出されるたびに `onDecode` を呼ぶ。戻り値の停止関数を、画面を離れるときに必ず呼ぶこと（カメラを掴んだままにしない）。

### 想定フロー

1. 送信側: `exportOwnSyncFile()` の `content` を `encodeAsQrSvg()` に渡し、画面にQRを表示
2. 受信側: `startQrScan()` でカメラを起動し、QRを読み取る → 得られたテキストを `importSyncFiles([{ name: 'qr', content: text }], deps)` に渡す

---

## 4. ③共有フォルダ（`folderTransport.ts`）

Dropbox・OneDrive・Google Driveアプリなど、**利用者が既に持っている同期フォルダ**をこのアプリの同期先として1回だけ指定させる方式。File System Access API（`showDirectoryPicker` 等）を使う。

### 対応環境の制約

**PC版のChrome/Edgeのみ対応。Android Chromeでは使えない**（[caniuse: native-filesystem-api](https://caniuse.com/native-filesystem-api)）。`isFolderSyncAvailable()` で機能検出し、非対応環境ではQR・ファイル書き出しに誘導する想定。

### TypeScript型の補足

TS標準の `dom` ライブラリには File System Access API の拡張部分（`showDirectoryPicker`・`queryPermission`/`requestPermission`・非同期 `entries()`）がまだ含まれていないため、`folderTransport.ts` 内で最小限の型を補っている（`src/keystore/webauthn.ts` のPRF拡張型と同じやり方）。

### フォルダ参照の永続化（`syncFolder` テーブル、Dexie v3で追加）

`FileSystemDirectoryHandle` は構造化複製可能なオブジェクトなので、IndexedDBにそのまま保存できる（Chrome 86+）。`repositories/syncFolder.ts` が1行だけ保存する。**ただし権限（readwrite）自体は保存されない**ため、次回起動時は `ensureFolderPermission()` で `queryPermission`→必要なら `requestPermission` を呼び直す必要がある（ユーザー操作起点でないと許可ダイアログが出ない点に注意）。

### 想定フロー

1. 初回: `pickSyncFolder()` でフォルダを選ばせ、`repositories/syncFolder.ts` に保存
2. 以降起動時: 保存済みハンドルを読み出し、`ensureFolderPermission()` で権限確認
3. 同期時: `readAllSyncFilesFromFolder(dir)` で `device-*.json` を全件読み、`importSyncFiles()` に渡す。続けて `exportOwnSyncFile()` の結果を `writeSyncFileToFolder(dir, file)` で書き込む

---

## 5. PC中継フロー（共有フォルダにアクセスできない端末のため）— `exportFullSnapshot()`

共有フォルダ方式（§4）はPC版Chrome/Edge限定のため、**Androidは共有フォルダの中身（他端末の`device-*.json`群）を直接読めない。** PCを中継役にして、Androidの分をPCへ送り、PCが共有フォルダ経由で得ている情報も含めて「知っている全部」をAndroidへ送り返す。

```
① Android: exportOwnSyncFile() → QR/ファイルでPCへ
② PC: importSyncFiles([Androidの分]) → 通常のマージ（共有フォルダ経由の他端末分と合流）
③ PC: exportFullSnapshot() → 「PCが知っている全部」をQR/ファイルでAndroidへ
④ Android: importSyncFiles([③]) → 通常のマージ
```

### なぜ④は「上書き」ではなく「マージ」でよいのか（2026-07-27設計判断）

最初「PCの結果をAndroidの単語帳へそのまま上書きする」という案も検討したが、**通常のマージのままで済む**と判断した。理由:

- `exportFullSnapshot()` は `exportOwnSyncFile()` と違い、`notes`/`asks` を `deviceId` で絞らない（**自分が編集した分だけでなく、他端末から取り込んで得た分も含めて全部**を返す）。中身は同じ `SyncFile` 形式なので、受け取り側は既存の `importSyncFiles()` をそのまま使える（新しい「上書きモード」を作る必要が無い）
- 「上書き」だと、**Androidが③を受け取るまでの間にAndroidだけで新しく発言した内容が消えてしまう**リスクがある。「マージ」なら、`mergeSnapshot()` の newest-wins ロジックにより自然に両方が残る（`sync.test.ts` の「does not lose new local edits...」で確認済み）
- 結果として得られる状態は「PCの全部を上書きした場合」と基本的に同じか、それより安全（Android側の新しい編集を失わない分だけ優れている）

このため `exportFullSnapshot()` の追加以外、新しいコードは要らなかった（`importSyncFiles()`・`mergeSnapshot()`・検証はすべて既存のものをそのまま再利用）。

---

## 6. Drive同期との違い（まとめ）

| | Drive同期（`src/drive/`。休眠中） | 手動同期（`src/manualSync/`） |
|---|---|---|
| ファイル一覧の取得 | Drive APIで自動列挙 | 利用者が選ぶ／共有フォルダから列挙 |
| アップロード | 自動（`runSync()`内で完結） | 明示的な書き出し操作、または共有フォルダへの書き込み |
| 外部アカウント設定 | 必要（Google Cloud、docs/drive-sync.md §2） | **不要**（共有フォルダ方式は利用者が既に持つ同期ツールに乗るだけ） |
| 同期の即時性 | アプリを開けば自動チェック可能（要トリガー配線） | 手段による（ファイル書き出し・QRは都度操作、共有フォルダは開くたびに自動チェック可能） |
| マージロジック | `mergeSnapshot()`（共通） | 同じ |

---

## 7. 未決定・要検討

- **UI自体が無い**: エクスポート・インポートのボタン、QR表示・スキャン画面、共有フォルダの設定画面、PC中継フローの画面、`skippedFiles`/`conflicts`の表示、承認画面。すべて未実装
- **「双方向」の運用が利用者任せ**（ファイル書き出し・QR・PC中継）: 決まった手順書やUIガイドが無いと、エクスポート・インポートの順序を間違えやすい（例: 古いファイルを誤って再インポートしても`mergeSnapshot()`の冪等性により実害は無いはずだが、実機での使い勝手は未検証）
- **通知・リマインダーが無い**: 「最後にいつ同期したか」を可視化する仕組みが無く、同期を忘れがちになる可能性がある
- **QRのアニメーション分割は未実装**（§3）。大きなデータのやり取りにはファイル書き出しか共有フォルダを使うしかない
- **共有フォルダの権限再確認がユーザー操作起点必須**（§4）。アプリ起動直後に自動でフォルダを読みに行く、という完全自動化はできない可能性がある（ブラウザの権限モデル上の制約）。実機での挙動は未検証
- **PC中継フロー（§5）は手順が4ステップと長い**。UIでどこまで自動化・簡略化できるかは未検討

---

## 関連文書

- [要件定義書](./requirements.md) — §5.5 方針転換の経緯
- [Drive同期クライアント設計](./drive-sync.md) — 休眠中のDrive経由同期
- [データ層設計](./data-layer.md) — `mergeSnapshot()` の仕様
