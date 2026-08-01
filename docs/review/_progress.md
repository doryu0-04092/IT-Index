# 進捗 — it-index 品質検証

最終更新: 2026-08-01（Stage C 2波目完了）
現在地: Stage C 3波目（エージェント7〜9）開始前

## 完了
- [x] 計画作成・承認（C:\Users\tubor\.claude\plans\it-ui-humble-summit.md）
- [x] original-request.md 保存
- [x] Step 0（settings.json一時緩和）は**実施しないことに変更**。Auto Modeの分類器にその都度判断させる方針（agent-kit/log/decisions/2026-08-01-settings.json一時緩和をやめAutoModeに委ねる.md 参照）
- [x] Issue #25 起票 → ブランチ feat/25-verification-infra
- [x] Stage A  検証基盤（Playwright / @axe-core/playwright / @lhci/cli / ESLint 追加。全パッケージnpm実在確認済み）
- [x] A-5      判定器の決定性確認 **3回連続一致**（docs/review/logs/visual-determinism.txt）
- [x] Stage A  PR #26 作成 → 本人承認 → squash merge → master反映済み（ブランチ削除済み）
- [x] tsc --noEmit / vitest run(171件) 通過確認済み。eslintは14 errors検出（ゲート化せず件数測定のみ、docs/review/logs/eslint.txt）

## 完了（続き）
- [x] 監査①（Stage A終了時点）— **ずれ無し**
- [x] Stage B  ゲート一括実行（PR #28 マージ済み）
  - ✅ tsc / vitest(171) / gitleaks / npm audit signatures
  - ❌ npm audit --audit-level=high（@lhci/cli起因、upstream未修正）
  - ❌ semgrep（src/ai/logError.ts unsafe-formatstring x2、Docker経由で実行）
  - ❌ playwright a11y（TopNav color-contrast違反, serious）
  - ⚠️ lhci未完走（Windows環境固有のchrome-launcher EPERM。目標分類のためゲートではない）
  - 記録用Issue #27、詳細: docs/review/logs/stage-b-summary.md

## Stage C 1波目 完了（エージェント1〜3）
- [x] エージェント1: アクセシビリティ — `docs/review/agents/01-accessibility.md`（ゲート違反2件: TopNavコントラスト4.02, btn-primaryダーク2.41。観点4件: role=dialog無し・フォーカストラップ無し・aria-label不統一・Skeleton読み上げ無し）
- [x] エージェント2: ビジュアルデザイン — `docs/review/agents/02-visual-design.md`（ゲート違反2件、エージェント1と重複確認。観点5件: モーダル暗転効果無効・トークン迂回多数・ピルバッジ崩れ・デッドCSS2件・spinner色不整合）
- [x] エージェント3: 操作フロー・使用感 — `docs/review/agents/03-operation-flow.md`（ゲート違反1件: ブラウザバックで白紙化。目標未達3件: リロードで文脈喪失・確定処理の進行不可視・確定失敗の痕跡なし。IME回帰確認は問題なし）
- [x] 3エージェントともセッション上限で一度中断→再開して完走（SendMessageで再開）
- [x] 記録用Issue #29 起票、ブランチ docs/29-stage-c-agent-reports で報告をコミット予定

## Stage C 2波目 完了（エージェント4〜6）
- [x] エージェント4: キーボード・レスポンシブ — `docs/review/agents/04-keyboard-responsive.md`（観点8件: 矢印キー未対応・TermPickerもEscape不可(新規)・disabled確定ボタンのTab欠落等。フォーカスリング・レスポンシブ4段階・200%ズームは問題なしと確認）
- [x] エージェント5: 機能性・エッジケース — `docs/review/agents/05-functionality.md`（ゲート違反2件: 漢数字「三層」が0件検索・非対応ブラウザバナー未実装。ゲート違反1件: シード失敗時に読み込み中とエラーが同時表示されリトライ手段皆無。観点3件）
- [x] エージェント6: セキュリティ — `docs/review/agents/06-security.md`（ゲート違反1件: CSP皆無。観点1件: GeminiのAPIキーがURLクエリに乗る。XSS経路・APIキー暗号化保存・権限要求は設計通りと確認＝正の結果）

## 未完了（次にここから）
- [ ] Stage C  エージェント7〜9（3波目: 性能 / 信頼性 / 保守性）
- [ ] 監査②（Stage C終了時点）
- [ ] Stage D  統合とIssue起票
- [ ] 監査③（Stage D終了時点）
- [ ] Stage E  実装（Issue単位）
- [ ] 監査④（Stage E終了時点）
- [ ] Stage F  最終ゲートとレポート

## 再開時にまず読むもの
1. このファイル（docs/review/_progress.md）
2. C:\Users\tubor\.claude\plans\it-ui-humble-summit.md（計画）
3. docs/review/original-request.md（本人の元の依頼文）

## 注記
- it-index の既定ブランチ: master / remote: https://github.com/doryu0-04092/IT-Index.git
- gh 認証済み（doryu0-04092、scopes: repo, workflow）
- マージは squash、直前に本人確認を毎回取る（settings.jsonの緩和なしのため、Auto Modeの都度確認 = この確認プロセスそのもの）
