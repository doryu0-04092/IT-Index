# エージェント4 — キーボード操作・フォーカス管理・レスポンシブ検証（it-index）

実施日: 2026-08-01

検証方法: Playwright実測（`e2e/investigate-keyboard/keyboard.investigate.spec.ts`、一時spec）。`npm run build`後、`npx vite preview --port 4174`で専用サーバーを起動し検証（他エージェントとのポート競合回避）。実APIキー不使用、`page.route()`でAnthropic/OpenAI/Geminiをモック。3510語シード取り込み完了(`.search-status`)を待機。`01-accessibility.md`の既報告内容（モーダルのrole/フォーカストラップ欠如/開いた瞬間のフォーカス移動なし/Escape不可）は重複報告しない。

## [1] 検索欄・TermPickerとも、結果候補への矢印キー移動が一切実装されていない
- 種別: 観点
- 画面: search / TermPickerモーダル
- 現象: 検索欄にフォーカスがある状態でArrowDownを2回押しても`document.activeElement`は検索欄のまま変化しない。候補一覧（`<ul class="search-results">` → `<button>`の並び）にkeydownハンドラやroving tabindexが存在しない（`src/ui/pc/SearchScreen.tsx:168-190`, `src/ui/pc/TermPicker.tsx:49-59`）。候補へはTabキーで1つずつ辿るしかない。
- 再現手順: 1. 検索欄に「ネットワーク」と入力 2. 検索欄にフォーカスしたままArrowDownを押す 3. `document.activeElement`を確認（変化なし）
- 証拠: 実行ログ「arrow-nav before/afterDown/afterDown2」がすべて同一（`.search-input`のまま）。TermPickerでも同様（「TermPicker arrow before/after」ログ）。
- 影響: キーボード利用者にとって、多くの候補一覧UI（コンボボックス的な挙動）で期待される矢印キー操作ができず、Tabキーのみに頼る必要がある。致命的な操作不能ではないが、標準的なリストボックス操作を期待するユーザーには意外な挙動。
- 確信度: 確認済み

## [2] 検索結果1行につきTab移動先が2箇所あり、多件数時にTabの必要回数が線形に増える
- 種別: 観点
- 画面: search
- 現象: `src/ui/pc/SearchScreen.tsx:175-187`の各結果行は「用語を選ぶ」ボタン（`.search-result`）と「この語について聞く」ボタン（`.search-result-ask-ai`）の2つを持つ。実測でTab9(検索欄)→Tab10(AIに聞くヒント)→Tab11(1件目選択)→Tab12(1件目AIに聞く)→Tab13(2件目選択)…と2 Tab/行で進む。`MAX_RESULTS=30`のため最大60 Tab強で末尾に到達する（トラップは無く完走は可能）。
- 再現手順: 1. 検索欄に「ネットワーク」と入力 2. Tabキーを連打し`document.activeElement`を記録
- 証拠: 実行ログ「search-with-query」Tab11〜15
- 影響: キーボードのみで多数候補から目的の語を探す際、Tab回数が多く体感的に重い。トラップではないため完走は可能。
- 確信度: 確認済み

## [3] TermPickerの候補も一致件数が多いと（本件では20件）キャンセルボタンまで21回Tabが必要、かつEscapeで閉じない
- 種別: 観点
- 画面: TermPickerモーダル（チャット画面の「話題を変える」/「用語を選ぶ」から開く）
- 現象: 1文字（「ネ」）で検索すると`MAX_RESULTS=20`件がヒットし、入力欄からキャンセルボタンまでTabキーを21回押す必要がある（実測）。加えてEscapeキーを押してもモーダルは閉じない（`document.activeElement`は変化せず、`.term-picker`はDOM上に残存）。TermPickerには`01-accessibility.md`[4]で指摘されたSettingsModal/OnboardingModalと同様、keydownハンドラが存在しない（`src/ui/pc/TermPicker.tsx`全体にkeydown/Escape処理なし）。これはSettingsModal/OnboardingModal以外の第3のモーダルでも同じ欠陥パターンが再現していることを示す新規確認（`01-accessibility.md`はTermPickerを検証対象にしていない）。
- 再現手順: 1. 自由な質問チャットを開く 2. 「用語を選ぶ」をクリック 3. 「ネ」と入力（20件ヒット） 4. Tabキーを押し続け、キャンセルボタンに到達するまでの回数を数える（21回） 5. 別セッションでEscapeキーを押す→閉じない
- 証拠: 実行ログ「TermPicker result count for query "ネ": 20」「reached cancel button after 21 Tabs」「TermPicker still open after Escape: true」
- 影響: 候補を選ばずに離脱したいユーザーが、多数候補時に21回のTab、またはマウスでのオーバーレイクリック以外に手段を持たない。SettingsModal/OnboardingModalに次ぐ3つ目の「Escapeが効かないモーダル」であり、パターンとして横展開していることを示す。
- 確信度: 確認済み

## [4] TermPickerの候補ボタンはEnterキーで確定でき、入力欄にはautoFocusがあり、この点はSettingsModal/OnboardingModalより優れている（良好事例）
- 種別: 観点（参考・良好事例）
- 画面: TermPickerモーダル
- 現象: TermPickerを開いた瞬間の`document.activeElement`は入力欄（`autoFocus`が効いている、`src/ui/pc/TermPicker.tsx:47`）。また候補ボタンにフォーカスがある状態でEnterキーを押すと選択され、モーダルが閉じてチャットの主題が切り替わることを確認した（`TermPicker closed by Enter on result button: true`）。
- 再現手順: 1. TermPickerを開く 2. `document.activeElement`が入力欄であることを確認 3. 候補ボタンにフォーカスしEnterを押す
- 証拠: 実行ログ「TermPicker activeElement at open: {"tag":"INPUT","cls":"search-input"...}」「TermPicker closed by Enter on result button: true」
- 影響: なし（良好事例として記録。ただしEscapeが効かない点は[3]で別途指摘）。
- 確信度: 確認済み

## [5] チャット画面（自由な質問）は「確定する」ボタンがdisabled状態だとTab順から消えるため、メッセージ未送信時はTab移動だけでは存在に気づけない
- 種別: 観点
- 画面: chat
- 現象: `src/ui/pc/ChatScreen.tsx:227-234`の確定ボタンは`disabled={messages.length === 0}`。メッセージが1件も無い状態でTabキーのみで画面末尾まで辿ると、確定ボタンは（disabled要素は非フォーカス対象のため）Tab順から欠落し、テーマ切替ボタン→BODYへ飛ぶ（実測: Tab14が`toolbar-btn`、確定ボタンは出現しない）。1件送信後は同じ手順でTab14に確定ボタンが出現することを確認した。
- 再現手順: 1. 自由な質問チャットを開く 2. 何も送信せずTabキーを14回押し`document.activeElement`を記録（確定ボタンが出ない） 3. メッセージを1件送信 4. 同様にTabで辿ると確定ボタンがTab14に出現
- 証拠: 実行ログ「chat-free-full」Tab14=`toolbar-btn`（未送信時）／「chat-free-with-message」Tab14=`chat-commit-button`（送信後）
- 影響: 機能不全ではない（disabledは正しい状態管理）。ただし視覚的にボタンがグレーアウト表示されている一方、スクリーンリーダー利用者やTabのみで存在確認する利用者は、メッセージを送るまで確定ボタンの存在自体を知る手段がTab移動では得られない（見た目のグレー表示に頼るしかない）。
- 確信度: 確認済み

## [6] フォーカスリング（`:focus-visible`）は`--accent`色のボタン上でも実際には視認できる（確認したが問題なし）
- 種別: 観点（確認結果・問題なし）
- 画面: 全画面共通（`.btn-primary`, `.top-nav-item.active`）
- 現象: `src/index.css:91-94`の`:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }`は、ボタン自体の背景/文字色が既に`var(--accent)`である`.btn-primary`・`.top-nav-item.active`上でも、`outline-offset: 2px`によりページ背景色（`--bg`）の隙間を挟んでリングが描画されるため、実測スクリーンショットで明確に視認可能なリングとして確認できた（ライト・ダーク両テーマ）。`outline: none`によるリング無効化はソース全体（`src/`配下）に一切存在しないことも`grep`で確認した。
- 再現手順: 1. ライト/ダーク双方でTabキーにより`.btn-primary`（「フォルダを作成」）と`.top-nav-item.active`（「検索」）に実際にフォーカスを移す 2. スクリーンショットで視認性を確認
- 証拠: `docs/review/agents/screenshots/keyboard/focusring-btnprimary-light.png`, `focusring-btnprimary-dark.png`, `focusring-topnav-active-light.png`, `focusring-topnav-active-dark.png`
- 影響: なし。文字色/背景色自体のコントラスト不足は`01-accessibility.md`[1][2]で既報告済み（別問題）であり、フォーカスリングの視認性そのものは本検証では問題を確認できなかった。
- 確信度: 確認済み（ただし`.focus()`（スクリプト）による疑似フォーカスでは`outlineStyle: solid`という計算値は得られるがChromiumの`:focus-visible`ヒューリスティックの影響で実際のリング描画がTabキー操作時と異なる可能性があるため、本検証は必ず実際のTabキー押下による測定に統一した）

## [7] ビューポート1440/1024/768/375のいずれでも横スクロールは発生しない。ただし狭幅であることを利用者に伝える案内は存在しない
- 種別: 観点
- 画面: search / detail / chat
- 現象: `document.documentElement.scrollWidth === clientWidth`が4段階すべて（1440/1024/768/375）で一致しており、横スクロールは発生しない（`.app { max-width: 720px; margin: 0 auto; padding: 24px 16px 64px; }`がフルードに縮小するため）。目視でも文字の折り返し・ボタンの重なり等の破綻は確認できなかった（TopNav4項目・chat-quick-asks2ボタン等も375pxで1行に収まっている）。一方、`src/index.css`には`@media`によるレイアウト用ブレークポイントが一切無く（ダークモード用の1件のみ）、`docs/ui-pc.md`が明言する「PC専用設計・Android版は別途」という方針に反して、狭幅ブラウザで開いた利用者に対し「この幅は非対応です」等の案内は一切表示されない。結果的に「崩れて壊れる」ことはないが「非対応であることが伝わらないまま、たまたま見た目が保たれている」状態。
- 再現手順: 1. ビューポートを1440/1024/768/375の順に変更 2. search/detail/chat各画面を表示しスクリーンショットと`scrollWidth`/`clientWidth`を記録
- 証拠: 実行ログ「viewport 1440/1024/768/375 search/detail/chat scrollInfo」（全て`scrollWidth===clientWidth`）。スクリーンショット: `docs/review/agents/screenshots/keyboard/viewport-{1440,1024,768,375}-{search,detail,chat}.png`
- 影響: 実害（崩れ）は無いが、方針として非対応と明言している幅で警告なく普通に操作できてしまうため、狭幅環境の利用者が「対応している」と誤認しても気づく手段がない。将来CSSが少し変わった際に無警告のまま崩れるリスクの土台にもなる。
- 確信度: 確認済み

## [8] 200%ズーム相当（640×512換算）でも横スクロールは発生しない（WCAG 1.4.10 Reflow: 確認したが問題なし）
- 種別: 観点（確認結果・問題なし）
- 画面: search / detail
- 現象: 実ウィンドウ1280×1024で200%ズームした場合のCSS px換算にあたる640×512のビューポートで検証した結果、search/detail両画面とも`scrollWidth === clientWidth`（横スクロールなし）だった。
- 再現手順: 1. ビューポートを640×512に設定 2. search画面、続けて検索→詳細画面遷移後のdetail画面で`scrollWidth`/`clientWidth`を記録
- 証拠: 実行ログ「zoom-equivalent(640x512) search/detail scrollInfo」。スクリーンショット: `docs/review/agents/screenshots/keyboard/zoom200-search.png`, `zoom200-detail.png`
- 影響: なし
- 確信度: 確認済み（`document.body.style.zoom`によるブラウザネイティブズームそのものではなく、CSS px換算のビューポート縮小による疑似再現である点に留意——真のズーム機構とは異なりうる）

---

## 確認できなかったこと
- **`document.body.style.zoom`や`deviceScaleFactor`による真のブラウザズーム機構での再現**: Playwright/Chromiumのheadless実行下で`body.style.zoom`はレンダリングに反映されるが、OS/ブラウザのネイティブズーム（Ctrl+/実際のズームUI操作）とは異なる可能性があり、今回はCSS px換算のビューポート縮小（640×512）で代替した。実際のズームAPIとの差異は未検証。
- **history画面のタブ切り替え（重み付け/時系列）をキーボード（Enter/Spaceでボタン押下）で実際に切り替えられるかの動作確認**: Tab順の到達は確認したが、Enter/Spaceキーで`view`stateが実際に切り替わることの実測はしていない（ネイティブ`<button>`のため理論上は動作するはずだが、明示的な検証はしていない）。
- **`SettingsModal`内`ApiKeyPrompt`（editingKey状態）固有のキーボード操作性**: `01-accessibility.md`が「未検証」としている領域であり、今回もキーボード観点としては未検証（スコープを4画面+TermPickerに絞ったため）。
- **実際のスクリーンリーダー（NVDA/VoiceOver）併用時の挙動**: 一切未検証（Playwrightでのキー操作・DOM/CSS確認のみ）。
- **TopNav・chat-quick-asksが375pxよりさらに狭い環境（例: 320px、旧型スマートフォン相当）で折り返すかどうか**: 375pxまでは確認したが、それ未満の幅は検証していない。
- **タッチ操作（スワイプ等）でのアクセシビリティ**: `docs/ui-pc.md`がPC専用設計と明言しているため対象外とした。
- **`.chat-error`等、条件分岐でしか出現しないエラー表示のフォーカス移動先**: エラー発生時にフォーカスがそのメッセージに移動するか（`aria-live`等）は未検証。`01-accessibility.md`でも同要素は「未検証」と記載されている。

## 主なファイル・エビデンス一覧
- 調査用spec: `c:\Project\study\it-index\e2e\investigate-keyboard\keyboard.investigate.spec.ts`
- スクリーンショット: `c:\Project\study\it-index\docs\review\agents\screenshots\keyboard\` 配下
- 関連ソース: `src/ui/pc/SearchScreen.tsx:168-190`, `src/ui/pc/TermPicker.tsx`, `src/ui/pc/ChatScreen.tsx:227-234`, `src/index.css:91-94`（`:focus-visible`）, `src/index.css:196-200`（`.app`のmax-width）

ソースコード・設定ファイルの変更、git操作は一切行っていない。
