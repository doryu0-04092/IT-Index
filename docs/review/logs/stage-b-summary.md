# Stage B — ゲート一括実行 結果まとめ

実施日時: 2026-08-01

| ゲート | コマンド | 結果 | 備考 |
|---|---|---|---|
| 型チェック | `tsc --noEmit` | ✅ 通過 | エラー0 |
| 既存テスト | `vitest run` | ✅ 通過 | 35ファイル / 171テスト全通過 |
| 秘密情報 | `gitleaks detect --redact` | ✅ 通過 | 24コミット・約4.16MBをスキャン、検出0件（docs/review/logs/gitleaks.txt） |
| 依存脆弱性 | `npm audit --audit-level=high` | ❌ **失敗**（exit 1） | 5件（high 1 / moderate 2 / low 2）。**全て `@lhci/cli`（Stage Aで追加したdevDependency）の推移的依存**（tmp / uuid / inquirer / external-editor）。`@lhci/cli`最新版(0.15.1)でも解消せず、upstream未修正。実行時コード（ブラウザに配信されるコード）には影響しない、CIツール専用の依存。詳細: docs/review/logs/npm-audit.txt |
| 依存署名 | `npm audit signatures` | ✅ 通過 | 589パッケージ全て登録署名検証済み、94件のattestation確認済み |
| コード脆弱性(SAST) | `semgrep scan --config auto --error`（Dockerコンテナ経由） | ❌ **失敗**（Blocking findings 2件） | `src/ai/logError.ts` で `console.error` にテンプレートリテラル変数を渡している（unsafe-formatstring）。ログ偽造のリスクは低いが、ルール上はブロッキング扱い。詳細: docs/review/logs/semgrep.txt |
| E2E / アクセシビリティ / 視覚回帰 | `playwright test` | ❌ **失敗**（1 failed / 2 passed） | 検索画面のTopNavボタンで **color-contrast 違反（serious）** を検出（コントラスト比4.02、要求4.5:1）。視覚回帰2件は通過。詳細: docs/review/logs/playwright-full.txt |
| 性能 | `lhci autorun` | ⚠️ **未完走（環境固有）** | Windows上のchrome-launcherの一時ディレクトリ削除処理でEPERMが2回連続発生し、計測完走せず。lighthouseの監査処理自体は最後まで走っている。性能は「目標」分類（ゲートではない）のため、Stage Cのエージェント7に手動プロファイリングを引き継ぐ。詳細: docs/review/logs/lhci.txt |

## ゲート実行環境の補足

- gitleaks: GitHub Releasesから公式バイナリ(v8.30.1 windows_x64)を取得して実行。npm経由ではない
- semgrep: 公式にWindowsネイティブ非対応のため、Docker Desktop（既存インストール済み・停止中だったので今回起動）上の `semgrep/semgrep` コンテナで実行
- 両ツールとも `.tools/`（gitleaksバイナリ）・Dockerイメージは `.gitignore` 済みでコミット対象外

## 評価基準文書の原則との整合

- **「セキュリティは必ずゲートに置く」**: gitleaks / npm audit / semgrep を全て実行し、通過・失敗を問わずログをそのまま保存した
- **落ちたゲートを緩めていない**: `npm audit fix --force`（breaking change）は実行していない。semgrepのfindingも無効化していない
- **通ったゲートも明記した**（型・テスト・秘密情報・署名）

## 次のアクション

- `npm audit` failure（@lhci/cli起因）と `semgrep` finding（logError.ts）は、Stage D で Issue化を検討する
- `color-contrast` 違反は Stage C エージェント1（アクセシビリティ）が全画面規模で詳細調査する
- 性能はエージェント7が引き継ぐ
