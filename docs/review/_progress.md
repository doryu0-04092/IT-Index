# 進捗 — it-index 品質検証

最終更新: 2026-08-01（Stage E 実装中に中断。本人の指示により今回のセッションはここで終了）
現在地: Stage E（Issue単位の実装修正）進行中。次は #43（ピルバッジ崩れ）から

## 完了サマリ

- Stage A: 検証基盤導入（Playwright/axe-core/ESLint/lhci） — PR #26 マージ済み。判定器の決定性は3回連続一致で確認済み
- Stage B: ゲート一括実行 — PR #28 マージ済み。詳細: `docs/review/logs/stage-b-summary.md`
- Stage C: 9エージェント並列検証 — PR #30 マージ済み。詳細: `docs/review/agents/01〜09-*.md`
- Stage D: 統合・Issue起票 — PR #45 マージ済み。詳細: `docs/review/stage-d-summary.md`
  - ゲート違反8件・目標未達6件を**全てIssue化**（#31〜#44、観点は報告のみで今回は修正しない、を本人確認済み）
- 監査①②③（Stage A/C/D終了時点） — **いずれもずれ無し**

## Stage E（実装）進捗

実装順序: #34 → #31/32/33/42 → #38 → #36 → #40/41 → #43 → #39/#35（要方針確認） → #37（要仕様確認） → #44（任意）

### 完了・マージ済み
- [x] #34  CSP追加 — PR #48
- [x] #31/#32/#33/#42  コントラスト系4件 — PR #47（`--accent-text`/`--accent-solid`/`--error`トークン分離）
- [x] #38  シード失敗時リトライ皆無 — PR #49（リトライボタン追加。**注記**: 作業中にブランチを切り忘れmasterへ直接コミットしてしまったが、push前に気づき退避して修正した。postmortem記録済み: `agent-kit/postmortems/2026-08-01-Stage E実装中にブランチを切り忘れmasterへ直接コミット.md`）
- [x] #36  漢数字検索0件 — PR #50（0-9の単純漢数字→算用数字変換。既存テスト1件を漢数字と無関係な例に差し替え）
- [x] #40/#41  確定処理の進行可視化・失敗痕跡 — PR #51（Toast variant追加、失敗セッションID記録）
- [x] #43  ピルバッジ崩れ — PR #52（white-space:nowrap + flex-wrap、align-items:flex-start）
- [x] #35  ブラウザバック白紙化 — PR #53（history.pushState + popstateで軽量対応。本格ルーティングは見送り、本人確認済み）
- [x] #39  リロード文脈喪失 — **今回は対応見送り**（本格ルーティング実装が必要なため。Issueにコメント済み、クローズはしない）
- [x] #37  非対応ブラウザバナー未実装 — PR #54（browserSupport.ts新規、UA判定でバナー表示。単体テスト9件追加）

- [x] #44  性能 — **今回は対応しない**（本人確認済み。目標分類で実測値は許容範囲内。Issueにコメント済み、クローズはしない）

## Stage E 完了（14件中12件マージ、2件は本人確認のうえ対応見送り）
- マージ済み: #34, #31/32/33/42, #38, #36, #40/41, #43, #35, #37（実質10 PR）
- 対応見送り（本人確認済み、Issueにコメントして残す）: #39（リロード文脈喪失、本格ルーティングが必要）, #44（性能、目標分類で許容範囲内）

### Stage E以降の残り作業
- [ ] 監査④（Stage E終了時点）
- [ ] Stage F  最終ゲート再実行とレポート作成

## 再開時にまず読むもの
1. このファイル（`docs/review/_progress.md`）
2. `C:\Users\tubor\.claude\plans\it-ui-humble-summit.md`（計画）
3. `docs/review/original-request.md`（本人の元の依頼文）
4. `docs/review/stage-d-summary.md`（未対応Issueの詳細・出典）

## 再開時の実行手順（#43から）
```
cd /c/Project/study/it-index
git checkout master && git pull --ff-only
git checkout -b fix/43-pill-badge-wrap
# 対象: src/index.css の .search-result-field / .search-result（360-395行目付近）
# 現象: 長い分野名（例:「システム戦略」）が2行に折り返るとピル形状が崩れ、
#       align-items:baselineのため行の縦位置も不揃いになる
# 修正後: tsc --noEmit / vitest run / playwright test e2e/a11y e2e/visual を実行し
#         コミット→push→PR作成→本人にマージ確認
```

## 運用ルール（毎回のIssue対応で徹底すること）
1. **必ず最初にブランチを切る**（`git checkout master && git pull --ff-only && git checkout -b fix/<issue番号>-<内容>`）。前回これを忘れてmasterに直接コミットする事故があった
2. 実装後は `tsc --noEmit` / `vitest run` / `npx playwright test e2e/a11y e2e/visual` を必ず実行
3. 実データでの動作確認は一時spec（`e2e/investigate-*/`）で行い、確認後に削除してからコミットする
4. コミット→push→PR作成後、**マージは必ず本人に確認**（AskUserQuestionで）してから実行する
5. マージ後は `docs/review/_progress.md` を更新してコミットし、対応するGitHub Issueをクローズする

## 注記
- it-index の既定ブランチ: master / remote: https://github.com/doryu0-04092/IT-Index.git
- gh 認証済み（doryu0-04092、scopes: repo, workflow）
- マージは squash、直前に本人確認を毎回取る（settings.jsonの緩和なしのため、Auto Modeの都度確認 = この確認プロセスそのもの）
- 現在のmasterは全てクリーンな状態（未コミットの変更なし、全PRマージ済み）
