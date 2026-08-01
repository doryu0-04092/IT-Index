# エージェント1 — アクセシビリティ検証（it-index）

実施日: 2026-08-01

**検証方法**: axe-core (`@axe-core/playwright`, tags: `wcag2a, wcag2aa, wcag21a, wcag21aa`) を、4画面（search/detail/chat/history）× 2モーダル（SettingsModal/OnboardingModal）× ApiKeyPrompt（フルスクリーン版・SettingsModal内版）× ライト/ダーク、計16パターンで実行。証拠は `docs/review/agents/screenshots/a11y/*.axe.json`（axe結果生データ）と `*.png`（スクリーンショット）。一時specは `e2e/investigate-a11y/`（`full.investigate.spec.ts`, `focus-check.spec.ts`, `focus-check2.spec.ts`）。ソースコード・設定ファイルの変更、git操作は一切行っていない。

**重要な前提の訂正**: 初回実行時はアニメーション（`.screen-fade-in`など、opacity 0→1）を無効化せずに計測したため、`term-detail-back`・`search-status`等に不正確なcolor-contrast値（例: 3.36等）が出た。`e2e/fixtures/base.ts`と同様にアニメーションを`animation-duration:0`で無効化して再計測したところ、これらは全て解消し、実際の定常状態での違反は2系統に収束した。この訂正過程自体が「axeの数値は計測条件に強く依存し、鵜呑みにできない」ことの実例。

---

## [1] TopNavのアクティブボタン、ライトテーマで色コントラスト不足（Stage B既知の違反が全画面に共通することを確認）
- 種別: ゲート違反
- 画面: search / chat(自由に質問) / history / SettingsModal / OnboardingModal / ApiKeyPrompt(モーダル内)（detailは非該当）
- 現象: `.top-nav-item.active`（文字色 `var(--accent)` #2f6feb、背景 `color-mix(accent 10%, transparent)` により実効 #eaf1fd）のコントラスト比が4.02:1。WCAG AA基準4.5:1未達。
- 再現手順: 1. ライトテーマでアプリを開く 2. 検索/履歴/自由に質問いずれかのTopNavボタンをアクティブにする（または設定モーダルを開いて「設定」がアクティブになる） 3. axe-coreを実行
- 証拠: `docs/review/agents/screenshots/a11y/search-light.axe.json`, `history-light.axe.json`, `chat-apikeyprompt-light.axe.json`, `chat-ready-light.axe.json`, `settings-modal-light.axe.json`（検索・設定の2ボタン同時に該当）, `settings-apikeyprompt-modal-light.axe.json`, `onboarding-modal-light.axe.json`。`src/index.css:225-229` (`.top-nav-item.active`)
- 影響: 弱視・ロービジョンのユーザーが「今どの画面にいるか」を示すアクティブ表示を判別しづらい。ダークテーマでは発生しない（実測コントラスト比 約6.4:1、計算上パス）。detail画面はTopNav項目がアクティブにならない仕様のため対象外。
- 確信度: 確認済み（Stage Bで検出済みの1件が、実は「アクティブなナビ項目がある画面全て」で再現する同一のCSSルール由来の問題であることを、今回全画面で確認した）

## [2] `.btn-primary`（塗りボタン）、ダークテーマで色コントラストが大きく不足（Stage B未検出・新規）
- 種別: ゲート違反
- 画面: search / detail / chat(ApiKeyPrompt双方) / history / SettingsModal / SettingsModal内ApiKeyPrompt / OnboardingModal（ほぼ全画面・全モーダル）
- 現象: `.btn-primary`（文字色 white、背景 `var(--accent)` = ダークテーマでは #6ea8fe）のコントラスト比が2.41:1。WCAG AA基準4.5:1に対し大幅未達（[1]の4.02より深刻）。同一パターンの`.history-tabs button.active`（同じくwhite on accent）も同ratio 2.41で該当。
- 再現手順: 1. ダークテーマに切り替える 2. 「フォルダを作成」バナーボタン／「この語についてAIに聞く」／ApiKeyPromptの「接続を確認」「設定」／履歴のアクティブタブ／SettingsModalの「フォルダを選択」／OnboardingModalの「次へ」等、`.btn-primary`または同等スタイルのボタンを画面に表示する 3. axe-coreを実行
- 証拠: `docs/review/agents/screenshots/a11y/search-dark.axe.json`, `detail-dark.axe.json`, `chat-apikeyprompt-dark.axe.json`, `chat-ready-dark.axe.json`, `history-dark.axe.json`, `settings-modal-dark.axe.json`, `settings-apikeyprompt-modal-dark.axe.json`, `onboarding-modal-dark.axe.json`。`src/index.css:108-112` (`.btn-primary`)、`--accent` ダーク値は `index.css:32/50`
- 影響: ダークテーマ利用者（弱視・ロービジョン含む）にとって、アプリ内で最も重要な主要アクション（AIに聞く／フォルダ作成／接続確認／確定系）のボタン文字がほぼ視認できないレベル。[1]より深刻かつ影響範囲が広い（プロダクト全体の主要CTA全て）。
- 確信度: 確認済み

## [3] SettingsModal・OnboardingModalに `role="dialog"` / `aria-modal` が無い
- 種別: 観点
- 画面: SettingsModal / OnboardingModal
- 現象: `src/ui/pc/SettingsModal.tsx:97-98`、`src/ui/pc/OnboardingModal.tsx:41-43` とも `<div className="modal-overlay">`→`<div className="modal-content">`の入れ子のみで、`role="dialog"`・`aria-modal="true"`・`aria-labelledby`（見出しh2への参照）が一切無い。
- 再現手順: 1. 各モーダルのソースを確認 2. スクリーンリーダーでモーダルを開いた場合、「ダイアログが開いた」ことも、見出し（例:「設定」）とダイアログの関連付けも通知されない
- 証拠: `src/ui/pc/SettingsModal.tsx:97-104`, `src/ui/pc/OnboardingModal.tsx:41-49`
- 影響: スクリーンリーダー利用者に、モーダルへのコンテキスト転換（フォーカス対象が変わったこと、これがモーダルダイアログであること）が伝わらない。axeは`role="dialog"`が存在する場合の下位ルール（aria-dialog-name等）のみ検証するため、role自体が無いこの状態は**axeでは0件・無検出**——「axeが通った＝アクセシブル」ではないことの具体例。
- 確信度: 確認済み（ソースコード直読）

## [4] SettingsModal・OnboardingModalにフォーカストラップが無く、開いた瞬間もフォーカスが移動しない
- 種別: 観点
- 画面: SettingsModal（実機検証）／OnboardingModal（コード上同一パターンのため推測適用）
- 現象: Playwrightでキーボード操作を実測した結果、以下を確認した。
  1. 「設定」ボタンをクリックしてモーダルを開いても、`document.activeElement`は開く前のまま「設定」ボタン（背景要素）に残り続ける（自動でモーダル内へフォーカス移動しない）。
  2. Escapeキーを押してもモーダルは閉じない（キーボードだけでの離脱手段が無い。マウスでオーバーレイをクリックするか✕ボタンを押すしかない）。
  3. モーダルを開いた状態でTabキーを押していくと、フォーカスはオーバーレイの**背後にある**ページ本体（バナーの「フォルダを作成」「後で設定する」→TopNavの検索/履歴/自由に質問/設定→検索画面の「重み付けビュー」「時系列ビュー」→検索入力欄…）を辿ってしまい、視覚的に隠れているはずの背景コンテンツがそのままTab移動可能な状態だった（フォーカストラップが全く機能していない）。DOM上、モーダル自体はJSXの末尾（`</main>`や`.app-toolbar`の後）に配置されているため、そこへ到達するには背景の全コントロールを一通りTabし終える必要がある。
- 再現手順: 1. `e2e/investigate-a11y/focus-check2.spec.ts`参照。設定モーダルを開く→`body`をクリックしてフォーカスをリセット→Tabを10回押し、都度`document.activeElement`を記録
- 証拠: 上記手順の実行ログ（Tab 1〜10がすべて背景要素に着地）。`src/App.tsx:420-448`（モーダルがJSX末尾に配置されている構造）、`src/ui/pc/SettingsModal.tsx`・`OnboardingModal.tsx`（focus()呼び出し・keydownハンドラが存在しない）
- 影響: キーボードのみで操作するユーザー・スクリーンリーダー利用者は、モーダルを開いた直後に期待される「ダイアログ内で完結した操作」ができず、視覚的に隠れている背景のボタン（ヘッダーの「フォルダを作成」やTopNavなど）を誤って操作してしまうリスクがある。axeはフォーカス管理・キーボードトラップの有無を実行時イベントとして検証しないため、この種の問題は**axeでは検出できない**。
- 確信度: SettingsModalについては確認済み（実測）。OnboardingModalは同一の実装パターン（focus()呼び出し・role・keydownハンドラいずれも無し）であることをコードで確認したのみで、Tabキー実測はしていないため推測（ただし構造上ほぼ同じ結果になる可能性が高い）。

## [5] SettingsModalの閉じるボタン（✕）にaria-labelが無く、他の同型ボタンと扱いが不統一
- 種別: 観点
- 画面: SettingsModal
- 現象: `src/ui/pc/SettingsModal.tsx:101-103`の閉じるボタンは`<button type="button" className="dismiss-error" onClick={onClose}>✕</button>`で`aria-label`が無い。同じ見た目・役割のボタンが OnboardingModal（`aria-label="閉じる"`, `OnboardingModal.tsx:46`）とToast（同上、`Toast.tsx:20`）には付いているのに、SettingsModalだけ欠けている。
- 再現手順: 1. 3ファイルのソースを比較する
- 証拠: `src/ui/pc/SettingsModal.tsx:101-103` vs `src/ui/pc/OnboardingModal.tsx:46` vs `src/ui/pc/Toast.tsx:20`
- 影響: `✕`という文字自体がaxeの「アクセシブルな名前がある」判定を満たしてしまう（テキストコンテンツとして認識されるため）ため**axeはこれを違反として検出しない**。しかし実際のスクリーンリーダーでは「✕」を「乗算記号」「バツ印」等、意味の伝わらない読み上げをする可能性が高く、同じアプリ内の他の✕ボタンが「閉じる」と明示的に読み上げられるのと比べて体験が不統一。「axeが通った＝アクセシブル」ではないことの具体例その2。
- 確信度: 確認済み（ソースコード直読、axe結果でbutton-name違反が一切出ていないことも確認済み）

## [6] Skeleton（読み込み中プレースホルダー）がaria-hidden="true"で、読み込み中であることがスクリーンリーダーに一切伝わらない
- 種別: 観点
- 画面: detail
- 現象: `src/ui/pc/Skeleton.tsx:9`で`<div className="skeleton" aria-hidden="true">`とし、中身（`skeleton-line`）ごと読み上げ対象から完全に除外している。TermDetailScreen（`src/ui/pc/TermDetailScreen.tsx:34`）は`term === undefined`の間このSkeletonを表示するが、代わりとなる「読み込み中です」のような視覚的に隠れたライブリージョンテキスト（`aria-live`や`sr-only`テキスト）は存在しない。
- 再現手順: 1. `TermDetailScreen`のコードを確認 2. `Skeleton`のコードを確認
- 証拠: `src/ui/pc/Skeleton.tsx:1-15`, `src/ui/pc/TermDetailScreen.tsx:15-36`
- 影響: スクリーンリーダー利用者は、詳細画面を開いた瞬間から用語データが表示されるまでの間、画面上で何が起きているか（読み込み中なのか、単に空白なのか）を一切知る手段がない。なお検索画面側は`.search-status`（「辞書を読み込み中です…」）が可視テキストとして存在し読み上げ対象になっているため、この問題はdetail画面（Skeleton使用箇所）に限定される。
- 確信度: 確認済み（ソースコード直読）。実際の読み込み待ち時間はIndexedDBアクセスのため非常に短く、体感インパクトの大きさは未検証。

---

## 未検証（axeが判定できない領域の手動推測評価）

- **読み上げ順序**: DOM順とビジュアル順は主要画面で概ね一致しているように見える（コード上、視覚的な並びとJSXの並びが一致）。ただし実際のスクリーンリーダー（NVDA/VoiceOver等）での読み上げ確認はしていない。推測。
- **代替テキストの内容の妥当性**: `aria-label="ライト/ダークモード切り替え"`（App.tsx:426）、`aria-label="閉じる"`（Toast/OnboardingModal）、`aria-label="AIが返答を作成中"`（ChatScreen.tsx:173、スピナー用）はいずれも内容として妥当に見える。SettingsModalの✕ボタンは[5]で指摘済み。他に画像・図表要素は無い（Mermaid図はプレーンテキストの`<pre>`表示で未描画、`src/ui/pc/TermDetailScreen.tsx:59-64`）。推測。
- **フォーカス順序の論理性**: [4]でSettingsModalについては実測したが、それ以外の画面（search/detail/chat/history本体）内でのTab順の論理性は個別に検証していない。
- **OnboardingModalの実機キーボード動作**: [4]に記載の通り、SettingsModalで確認した挙動から類推したのみで、Tabキーでの実測はしていない。
- **ApiKeyPrompt（SettingsModal内のeditingKey状態）のフォーカストラップ**: 個別には未検証（親のSettingsModal同様の構造のため同じ問題を抱えている可能性が高いが未実測）。
- **実際のスクリーンリーダー（NVDA/JAWS/VoiceOver）での動作確認**: 一切行っていない。axeとコード読解・Playwrightでのフォーカス/キーボード実測のみに基づく。
- **モバイル・タッチ操作でのアクセシビリティ**（スワイプ操作等）: 対象外（PC画面前提の構成のため）。
- **contrast計算の網羅性**: axeが実際にDOM上に存在し可視状態の要素のみを検査するため、条件分岐で特定の状態でしか出現しないUI（例: エラーメッセージ`.chat-error`（色 #d33、固定色でテーマ非対応）、認証エラーバナー等）は今回のシナリオでは出現せず未検証。`.chat-error`はライト/ダーク共通で赤(#d33)固定のため、背景色によっては別途コントラスト不足の可能性があるが、実際にエラーを発生させて検証していない。

**必須の注記（axeの限界について）**: axeが検出できるのは実際のWCAG違反のうち3〜4割程度とされる。今回の16パターンすべてでaxeが検出したのは`color-contrast`のみだったが、これは「他に問題が無い」ことを意味しない。実際、[3][4][5][6]はいずれもaxeが0件と判定した状態で確認された、コードレベルでは明白な問題である。「axeが通った＝アクセシブル」という判断は誤り。
