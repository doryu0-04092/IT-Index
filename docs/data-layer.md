# データ層設計（Dexie / IndexedDB）

- 版: 1.2（2026-07-30）
- 前提: [要件定義書](./requirements.md) / [アーキテクチャ](./architecture.md) / [初期データ形式仕様](./seed-format.md)

## 0. この文書の位置づけ

**「バックエンド」に相当する層はサーバーではなく、ブラウザ内のデータ層（IndexedDB ＋ 純関数コア ＋ リポジトリ）である。** 要件定義書 §3・§7 のとおり自前サーバーは持たない。

PC版（Chrome/Edge）とスマホ版（Android Chrome）は**同一の IndexedDB 実装を同一ブラウザエンジン上で使う**。したがって本文書で定義するスキーマ・型・リポジトリ層は**分岐なしで完全共通**にする。差分が出るのは React のUIコンポーネント（レイアウト・操作導線）だけであり、それはこの文書の対象外。

```
┌─────────────────────────────┐
│ UI（PC / スマホで分岐）          │ ← ここだけ差分調整
├─────────────────────────────┤
│ リポジトリ層（本文書 §3）          │ ← 完全共通
│ 純関数コア（本文書 §4）           │ ← 完全共通
│ Dexie スキーマ（本文書 §1-2）    │ ← 完全共通
└─────────────────────────────┘
```

---

## 1. ライブラリとバージョニング方針

- **Dexie.js** を IndexedDB のラッパーとして使う（生 IndexedDB API は書かない）
- スキーマ変更は Dexie の `db.version(n).stores({...})` で管理し、**既存 version 定義は変更せず、新しい version を追加**する（Dexie の破壊的マイグレーション事故を避ける定石）
- `schemaVersion`（seed-format §1）・`syncSchemaVersion`（architecture §4.2）とは**別物**。この Dexie バージョンは「ローカルDBの構造」だけを表す第三の版番号

```ts
// db.ts
import Dexie, { type Table } from 'dexie';

export class ItIndexDB extends Dexie {
  terms!: Table<TermRecord, string>;
  notes!: Table<NoteRecord, string>;
  asks!: Table<AskRecord, string>;
  chatSessions!: Table<ChatSessionRecord, string>;
  chatMessages!: Table<ChatMessageRecord, string>;
  settings!: Table<SettingsRecord, string>;
  keyStore!: Table<KeyStoreRecord, string>;
  syncFolder!: Table<SyncFolderRecord, string>;

  constructor() {
    super('it-index');
    this.version(1).stores({
      terms: 'id, field, origin, deletedAt',
      notes: 'termId, updatedAt',
      asks: 'id, termId, sessionId, [at+id]',
      chatSessions: 'id, termId, status, lastActiveAt',
      chatMessages: 'id, sessionId, at',
      settings: 'key',
    });
    // v2: 鍵ストア追加（§2.2）。既存 version(1) は変更せず追加するルールに従う
    this.version(2).stores({
      keyStore: 'key',
    });
    // v3: 手動同期「共有フォルダ方式」のフォルダ参照を保持（manual-sync.md §4）
    this.version(3).stores({
      syncFolder: 'key',
    });
  }
}
```

### 実装ステータス

`src/db.ts` に実装済み（version 1〜3）。テーブルごとの実装ファイル対応は以下のとおり。

| テーブル | リポジトリ | 純関数/補助モジュール |
|---|---|---|
| `terms` | `src/repositories/terms.ts` | `src/core/normalize.ts` / `src/core/score.ts` / `src/core/validateSeed.ts` / `src/seedImport.ts` |
| `notes` | `src/repositories/notes.ts` | — |
| `asks` | `src/repositories/asks.ts` | `src/core/computeWeights.ts` |
| `chatSessions` / `chatMessages` | `src/repositories/chat.ts` | — |
| `settings` | `src/repositories/settings.ts` | — |
| `keyStore` | `src/repositories/keyStore.ts` | `src/keystore/crypto.ts` / `src/keystore/webauthn.ts` / `src/keystore/apiKeyStore.ts` |
| `syncFolder` | `src/repositories/syncFolder.ts` | `src/manualSync/folderTransport.ts`（詳細は [manual-sync.md §4](./manual-sync.md)） |

`mergeSnapshot()` は `src/core/mergeSnapshot.ts` に実装済み。同期の主手段は[手動同期](./manual-sync.md)（ファイル書き出し／QRコード／共有フォルダの3方式。`src/manualSync/`）で、Drive経由（`src/drive/`）は休眠中（[drive-sync.md](./drive-sync.md)）。輸送手段に依存しない共通ロジックは `src/sync/` に集約。AIクライアント（チャット・分配統合）は `src/ai/` に実装済み。詳細は [ai-client.md](./ai-client.md)。

### インデックス選定の理由

| テーブル | インデックス | 理由 |
|---|---|---|
| `terms` | `field` | 分野フィルタ（あれば使う。無くても全件走査は数百〜千件なので許容） |
| `terms` | `origin` | 同期対象の絞り込み（`origin:'ai'` だけを同期に含める） |
| `terms` | `deletedAt` | tombstone 済みレコードの除外 |
| `terms.searchKey` / `readingKeys` | **インデックスしない** | 要件定義書 §5.1 のとおり検索は**全件走査＋スコアリング**が方針。インデックス検索（前方一致など）は方針と矛盾するので張らない |
| `notes` | `updatedAt` | 将来的な「最近更新した語」表示のため付与。無くても動くが安価なので先に張る |
| `asks` | `termId` | 用語ごとの `asks` 集計（重み付け計算の入力） |
| `asks` | `[at+id]` | 通し番号（`(時刻, id)` の複合キー）で全件を安定ソートするため。`computeWeights()` が使う |
| `chatSessions` | `status` | 起動時の未確定セッション検出（§4.3.5 状態遷移図の④） |
| `chatSessions` | `lastActiveAt` | 15分経過の判定 |
| `chatMessages` | `sessionId` | セッション単位でメッセージを取得 |

---

## 2. 型定義（ER図を実装レベルに落とす）

architecture.md §2 のER図に対応する。**同期対象かどうかは型コメントで明示する**（実装時にコピペミスを防ぐため）。

```ts
// types.ts

/** テクノロジ系・マネジメント系・ストラテジ系の24分類。seed-format.md §5 が正本 */
export type Field =
  | '基礎理論' | 'アルゴリズムとプログラミング' | 'コンピュータ構成要素'
  | 'システム構成要素' | 'ソフトウェア' | 'ハードウェア' | 'ヒューマンインタフェース'
  | 'マルチメディア' | 'データベース' | 'ネットワーク' | 'セキュリティ'
  | 'システム開発技術' | 'ソフトウェア開発管理技術' | 'AI'
  | 'プロジェクトマネジメント' | 'サービスマネジメント' | 'システム監査'
  | 'システム戦略' | 'システム企画' | '経営戦略マネジメント' | '技術戦略マネジメント'
  | 'ビジネスインダストリ' | '企業活動' | '法務';

/** Drive 同期対象外（配信データ由来）。origin:'ai' の語のみ例外的に同期対象 */
export interface TermRecord {
  id: string;                 // = normalize(term)。§2.1 参照
  term: string;
  readings: string[];         // 原則1要素
  summary: string | null;     // 不変・AIは触らない。origin:'ai'は初期説明という概念が無いのでnull（詳細はai-client.md §4.3）
  field: Field;
  tags: string[];             // 省略時は []
  searchKey: string;          // normalize(term)、事前計算
  readingKeys: string[];      // readings.map(normalize)、事前計算
  origin: 'seed' | 'ai';
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;   // tombstone。null = 未削除
}

/** Drive 同期対象（端末ごとに育つ唯一のデータ） */
export interface NoteRecord {
  termId: string;              // PK = FK（1用語1件なので termId をそのまま主キーにする）
  body: string;                // Markdown
  diagrams: string[];          // Mermaid文字列。body とは独立して壊れてよい
  updatedAt: number;
  lastEditedBy: string;        // deviceId
  noteHistory: NoteHistoryEntry[]; // 同期対象外。ロールバック用（要件定義書 §8「統合の反復」対策）
}

export interface NoteHistoryEntry {
  body: string;
  diagrams: string[];
  updatedAt: number;
}

/** Drive 同期対象（追記のみ・idで和集合） */
export interface AskRecord {
  id: string;                  // crypto.randomUUID()
  termId: string;
  sessionId: string | null;    // AIチャット確定由来のみ。ローカル検索確定（source:'search'）は null
  at: number;                  // epoch ms。(at, id) が通し番号の複合キー
  deviceId: string;
  source: 'ai' | 'search';     // 2026-07-29追加。重み付けの倍率が異なる（core/computeWeights.ts）
}

/** Drive 同期対象外（過程は共有しない。統合結果である notes/asks だけ共有） */
export interface ChatSessionRecord {
  id: string;
  termId: string | null;       // null = 自由チャット
  startedAt: number;
  lastActiveAt: number;
  status: 'open' | 'committed';
}

/** Drive 同期対象外 */
export interface ChatMessageRecord {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  at: number;
}

/** Drive 同期対象外。APIキーは含めない（要件定義書 §5.6 層6） */
export interface SettingsRecord {
  key: 'singleton';            // 常に1行しか存在しない固定キー
  deviceId: string;
  seedVersion: string | null;  // 取り込み済みの seed version。未取り込みは null
  autoUpdateExistingTerms: 'askedOnly' | 'all'; // 既存語の自動更新範囲。既定 'askedOnly'（2026-07-30追加。要件定義書§5.3）
  // driveToken 等の認可情報は別ストア（鍵ストア）で扱い、このテーブルには置かない。
  // 「同期対象外」を型レベルでも徹底するため、Drive同期のシリアライズ関数は
  // SettingsRecord を一切参照しない実装にする（下記§3.5参照）。
}

/**
 * Drive 同期対象外。APIキーの暗号化保存が明示的にオプトインされた場合のみ1行できる
 * （既定はセッションのみでこのテーブル自体が空のまま）。credentialId はパスキーの
 * 識別子で秘匿情報ではない。復号には毎回 WebAuthn PRF を要する（§2.2）。
 * provider/model は平文（秘匿情報ではない）。複数AIプロバイダ対応（2026-07-27。
 * ai-client.md §1.5）で、暗号化対象は apiKey のみに保ったまま追加した。
 */
export interface KeyStoreRecord {
  key: 'singleton';
  provider: AiProvider;
  model: string;
  credentialId: ArrayBuffer;
  ciphertext: ArrayBuffer;
  iv: Uint8Array<ArrayBuffer>;
}
```

### 2.1 `terms.id` の生成規則

**`normalize(term)` の結果をそのまま `id` にする。**（正規化はアーキテクチャ §6 の `normalize()` と同一関数を使う。かな統一・全半角・大小の統一のみ。）

```ts
function makeTermId(term: string): string {
  return normalize(term); // 例: "TCP/IP" → "tcp/ip"
}
```

- 人間が見て何の語か分かる／衝突判定がそのまま重複判定になる、という利点を優先する
- **`term` の表記を後から直したいリネームはできない**（id も変わってしまう）。シードは手動管理のためこの制約は実用上問題にならない（seed-format.md §2 も「`term` の重複禁止」を明記済みで、リネームという運用を想定していない）
- `origin:'ai'` の新規登録語も同じ関数で `id` を作るため、**シード語とAI登録語が偶然同じ表記なら自然に同一語として扱われる**（意図した挙動）

**実装時に判明した注意点**: `normalize()` は英字の大小を無視するため、`HTTP` と `http` のように**大小だけが違う別エントリ**は同じ `id` に潰れる。実データ（`public/seed/terms.json`）で実際に3件（`HTTP`/`http`、`IP`/`ip`、`ss`/`SS`）衝突しており、シード側を修正して解消した。`validateSeedFile()`（§4）は文字列としての完全一致重複しか検証しないため、**この種の衝突は検証をすり抜ける**。恒久的に防ぐには id 衝突チェックを検証に追加する必要があるが、未着手（§6）。

### 2.2 `keyStore` — APIキーの暗号化保存（要件定義書 §5.6 層2・層3）

`settings` とは別テーブルにする。理由は `settings` に将来 Drive 同期対象のフィールドが混ざる可能性を排除し、**「同期対象外の秘密情報」を型・テーブルの両方で settings から隔離**するため（§2 の `SettingsRecord` コメント参照）。

- 既定はこのテーブル自体が空（§5.6 層3「既定は保存しない」）。API キーはモジュールスコープの変数にセッション中のみ保持する
- 保存は明示的なオプトインでのみ1行できる。`credentialId`（パスキー識別子）と `ciphertext`/`iv`（AES-256-GCM）を持つ
- 復号鍵は**保存しない**。WebAuthn PRF 拡張から毎回導出する（PRF出力＝鍵material）ため、他端末に `keyStore` の中身をコピーしても復号できない
- Firefox 等 PRF 非対応環境では保存自体ができない（`registerPasskey()` が `prfSupported: false` を返し、呼び出し側がエラーにする）

---

## 3. リポジトリ層（Dexie を直接呼ばせない境界）

**UI・純関数コアのどちらも Dexie の Table を直接触らない。** リポジトリ層を経由させることで、①テスト時にモックしやすい ②将来 IndexedDB 以外に差し替える事態が来ても影響範囲が閉じる。

```ts
// repositories/terms.ts
export interface TermsRepository {
  getAll(): Promise<TermRecord[]>;               // 検索用。deletedAt!=null は除外して返す
  getById(id: string): Promise<TermRecord | undefined>;
  bulkPutFromSeed(terms: TermRecord[]): Promise<void>; // トランザクション。検証済みデータのみ受け取る
  upsertFromAi(term: TermRecord): Promise<void>;  // origin:'ai' の新規登録
  upsertFromSync(term: TermRecord): Promise<void>; // origin:'ai' の語のマージ結果を反映
}

// repositories/notes.ts
export interface NotesRepository {
  getByTermId(termId: string): Promise<NoteRecord | undefined>;
  applyCommit(termId: string, body: string, diagrams: string[], deviceId: string, at: number): Promise<void>;
  // ↑ 確定時のみ呼ばれる。呼ぶたびに noteHistory へ旧内容を退避してから上書きする
  upsertFromSync(note: NoteRecord): Promise<void>; // updatedAt 比較はこの内部で行わない。mergeSnapshot() が決定した結果をそのまま書く
}

// repositories/asks.ts
export interface AsksRepository {
  addMany(asks: Omit<AskRecord, 'id'>[]): Promise<void>; // 分配先の全語に1件ずつ、1トランザクションで追加（source:'ai'）
  addSearchConfirm(termId: string, deviceId: string, at: number): Promise<void>; // 2026-07-29追加。ローカル検索で用語詳細を開いた1件（source:'search'）
  getAllOrdered(): Promise<AskRecord[]>;          // [at+id] インデックスで全件取得。computeWeights() の入力
  getByTermId(termId: string): Promise<AskRecord[]>;
  upsertFromSync(asks: AskRecord[]): Promise<void>; // id の和集合。既存 id はスキップ
}

// repositories/chat.ts
export interface ChatRepository {
  createSession(termId: string | null): Promise<ChatSessionRecord>;
  appendMessage(sessionId: string, role: 'user' | 'assistant', content: string): Promise<void>;
  touchSession(sessionId: string, at: number): Promise<void>; // lastActiveAt 更新
  findStaleOpenSessions(now: number, timeoutMs: number): Promise<ChatSessionRecord[]>; // 起動時の④用
  commitSession(sessionId: string): Promise<void>; // status を committed に。冪等（既に committed なら何もしない）
  getMessages(sessionId: string): Promise<ChatMessageRecord[]>;
}

// repositories/settings.ts
export interface SettingsRepository {
  get(): Promise<SettingsRecord>;      // 無ければ deviceId を新規発行して1行作る
  setSeedVersion(version: string): Promise<void>;
  setAutoUpdateExistingTerms(mode: 'askedOnly' | 'all'): Promise<void>; // 2026-07-30追加
}

// repositories/keyStore.ts
export interface KeyStoreRepository {
  get(): Promise<KeyStoreRecord | undefined>;
  put(record: Omit<KeyStoreRecord, 'key'>): Promise<void>;
  clear(): Promise<void>;
}
```

**`keyStore` の上位層（`src/keystore/`）**: リポジトリの上にさらに「セッションのみ保持」「WebAuthn PRFでの導出・暗号化・復号」を組み合わせる `ApiKeyStore`（`src/keystore/apiKeyStore.ts`）を置く。WebAuthn自体は実機の認証器が無いとテストできないため `WebAuthnClient` インターフェースで抽象化し（`src/keystore/webauthn.ts`）、テスト時はフェイク実装を注入する。暗号化（AES-GCM）は Web Crypto API のみに依存する純粋なI/Oなので `src/keystore/crypto.ts` として単体テストする。

**すべてトランザクション境界を明示する**（`db.transaction('rw', ...)`）。特に「分配統合の確定」（複数語の notes 更新 + asks 追加 + session commit）は要件定義書 §5.3 のとおり冪等性が必須なので、1トランザクションで全部書く。

---

## 4. 純関数コア（architecture.md §6 の再掲＋型）

リポジトリ層とは独立に、**引数→戻り値だけで完結し副作用を持たない**関数として実装する。PC/スマホの分岐が起きようがないレイヤー。

```ts
// core/normalize.ts
export function normalize(input: string): string; // かな統一・全半角・大小のみ

// core/score.ts
export interface ScoredTerm { term: TermRecord; score: number; }
export function score(query: string, terms: TermRecord[]): ScoredTerm[]; // searchKey/readingKeys に対して2-gram Dice + 加点

// core/mergeSnapshot.ts
export interface SyncFile {
  syncSchemaVersion: 1;
  deviceId: string;
  writtenAt: number;
  notes: NoteRecord[];
  asks: AskRecord[];
  aiTerms: TermRecord[];
}
export interface MergeResult {
  notes: NoteRecord[];      // 決定的に確定した分（updatedAt比較）
  conflicts: NoteConflict[]; // AI統合が必要な分（両端末で更新された語）
  asks: AskRecord[];         // id の和集合
  terms: TermRecord[];       // aiTerms の和集合
}
export interface NoteConflict { termId: string; local: NoteRecord; remote: NoteRecord; }
export function mergeSnapshot(local: LocalSnapshot, remoteFiles: SyncFile[]): MergeResult;

// core/computeWeights.ts
export interface WeightedTerm { termId: string; weight: number; }
export function computeWeights(asksOrdered: AskRecord[], halfLife?: number): WeightedTerm[];
// score(語) = Σ w_i・r^(N-i), r = 0.5^(1/H), H既定50。要件定義書§5.4の式そのまま
// w_i はイベントの重み: ask.source==='ai' なら3、'search' なら1（2026-07-29追加。source未設定の旧レコードは'ai'扱い）

// core/validateSeed.ts（seed-format.md §8 の検証をそのまま実装。fetchもIndexedDBも持たない）
export type SeedValidationResult = { ok: true; file: SeedFile } | { ok: false; reason: string };
export function validateSeedFile(raw: unknown): SeedValidationResult;

// keystore/crypto.ts（Web Crypto APIのみに依存。ブラウザ/Node両対応でVitestの対象）
export function deriveAesKeyFromPrfOutput(prfOutput: ArrayBuffer): Promise<CryptoKey>;
export function encryptApiKey(key: CryptoKey, apiKey: string): Promise<EncryptedPayload>;
export function decryptApiKey(key: CryptoKey, payload: EncryptedPayload): Promise<string>;
```

### 4.1 なぜここも「共通」と言い切れるのか

これらは DOM にも `navigator` にも触れない純粋な TypeScript 関数であり、実行環境が Android Chrome か PC Chrome/Edge かで分岐する余地が構造的に無い。Vitest で単体テストする対象（architecture.md §6 既定方針）と完全に一致する。

---

## 5. Dexie スキーマ変更の運用ルール

1. **既存の `this.version(n)` 定義は変更しない。** 変更が必要になったら `this.version(n+1).stores({...}).upgrade(tx => {...})` を追加する
2. **フィールド追加だけなら新規 version は不要な場合が多い**（Dexie はインデックスされていないフィールドの追加を許容する）。**インデックスの追加・削除・型変更**が version を上げる基準
3. version を上げたら、この文書の §1 のコード例と §テーブル一覧を同時に更新する（コードとドキュメントの食い違いを防ぐ）

---

## 6. 未決定・要検討

- ~~`SettingsRepository.get()` の check-then-add が同時呼び出しで壊れる~~ → 修正済み（2026-07-27）。`get→無ければadd`という非アトミックな手順が、React StrictModeの二重effect実行下で実際に競合し「検索結果が常に0件になる」というブラウザ実機バグを引き起こしていた。トランザクション化＋`put`化で解消。詳細は [ui-pc.md §3](./ui-pc.md)
- `asks.id` / `chatSessions.id` / `chatMessages.id` の生成方式（`crypto.randomUUID()` を仮定しているが、Drive 同期ファイルのサイズ観点で ULID 等への変更余地あり）
- `NoteRecord.noteHistory` の保持件数上限（無制限だと同期ファイルが肥大化する可能性。ただし同期対象外なのでローカル肥大化のみが問題）
- `terms` の全件走査が数千語規模になった場合の性能実測（非機能要件 §6 の「体感遅延なく」を満たすか）
- **`validateSeedFile()` に id 衝突検証が無い**（§2.1）。文字列としての完全一致重複しか弾けず、`normalize(term)` が異なる term を同じ id に潰すケース（大小違いなど）を検証時に検知できない。実データで3件見つかりデータ側を修正して回避したが、検証自体は未強化のまま
- ~~未実装: AIクライアント~~ → 実装済み（`src/ai/`。詳細は [ai-client.md](./ai-client.md)）
- ~~未実装: Drive同期クライアント~~ → 実装済み（`src/drive/`。詳細は [drive-sync.md](./drive-sync.md)）だが、2026-07-27の方針転換により**休眠中**。同期の主手段は[手動ファイル書き出し](./manual-sync.md)（`src/manualSync/`。実装済み）
- ~~未実装: 確定オーケストレーション~~ → 実装済み（`src/ai/commitOrchestrator.ts`。詳細は [ai-client.md §5](./ai-client.md)）。ただしUIへの配線（`noteActivity`/`recoverStaleSessions`/`onProposalReady` を実際に呼ぶ場所）は未着手
- 未実装: **Service Worker / PWAマニフェスト**、**承認画面UI**、**同期のトリガー配線**（いつ `runSync()` を呼ぶか）
- `chatMessages` の `at` は `Date.now()` を単調増加になるよう補正して書き込む（`repositories/chat.ts`）。同一ミリ秒内の連続送信で会話順が壊れる実バグを実装中に見つけて修正した
- `TermRecord` に作成端末を追う `createdBy` 相当のフィールドが無いため、Drive同期の送信ファイルは `origin:'ai'` の語を全件含めてしまう（本来は「自分が作った語だけ」に絞りたい）。詳細は [drive-sync.md §5](./drive-sync.md)

---

## 関連文書

- [要件定義書](./requirements.md) — なぜこの構造なのか
- [アーキテクチャ](./architecture.md) — ER図・シーケンス図（本文書はこのER図の実装レベル詳細）
- [初期データ形式仕様](./seed-format.md) — `terms` の入力データ形式
