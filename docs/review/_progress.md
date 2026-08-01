# 進捗 — it-index 品質検証

最終更新: 2026-08-01（Stage A完了）
現在地: Stage B 開始前

## 完了
- [x] 計画作成・承認（C:\Users\tubor\.claude\plans\it-ui-humble-summit.md）
- [x] original-request.md 保存
- [x] Step 0（settings.json一時緩和）は**実施しないことに変更**。Auto Modeの分類器にその都度判断させる方針（agent-kit/log/decisions/2026-08-01-settings.json一時緩和をやめAutoModeに委ねる.md 参照）
- [x] Issue #25 起票 → ブランチ feat/25-verification-infra
- [x] Stage A  検証基盤（Playwright / @axe-core/playwright / @lhci/cli / ESLint 追加。全パッケージnpm実在確認済み）
- [x] A-5      判定器の決定性確認 **3回連続一致**（docs/review/logs/visual-determinism.txt）
- [x] Stage A  PR #26 作成 → 本人承認 → squash merge → master反映済み（ブランチ削除済み）
- [x] tsc --noEmit / vitest run(171件) 通過確認済み。eslintは14 errors検出（ゲート化せず件数測定のみ、docs/review/logs/eslint.txt）

## 未完了（次にここから）
- [ ] 監査①（Stage A終了時点のドリフト監査）
- [ ] Stage B  ゲート一括実行（gitleaks / npm audit / semgrep / playwright / lhci）
- [ ] Stage C  エージェント1〜3（1波目: a11y / ビジュアル / 操作フロー）
- [ ] Stage C  エージェント4〜6（2波目: キーボード・レスポンシブ / 機能性 / セキュリティ）
- [ ] Stage C  エージェント7〜9（3波目: 性能 / 信頼性 / 保守性）
- [ ] 監査①（Stage A終了時点）
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
