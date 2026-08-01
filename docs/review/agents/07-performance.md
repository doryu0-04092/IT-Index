# エージェント7 — 性能検証（it-index）

実施日: 2026-08-01

## 検証環境
- ビルド: `npm run build`（tsc -b && vite build）、生成物 `dist/`
- 計測サーバー: `npx vite preview --port 4176`（他エージェントとの4173競合回避のため専用ポート使用）
- 計測手法: Playwright（`playwright` パッケージ直接操作、テストランナーのwebServerは不使用）、`page.evaluate()`での`performance.now()`/`PerformanceObserver`実測
- 外部AI呼び出しはすべて`page.route()`でモック
- スクリプト: `c:\Project\study\it-index\e2e\investigate-performance\measure.cjs`（一時調査用）
- 生ログ: `c:\Project\study\it-index\docs\review\agents\screenshots\performance\measure-log.json`
- スクリーンショット: `c:\Project\study\it-index\docs\review\agents\screenshots\performance\fonts-fout-check.png`

**評価基準上の位置づけ**: 性能は「目標」分類（数値だが未達でも進行可能）。ゲートではない。

## [1] 初回シード取り込み（3510語）に約1.1〜4.1秒、実行順序で大きくばらつく
- 種別: 目標未達 / 観点
- 画面: SearchScreen（初回起動）
- 現象: IndexedDBを空にした新規コンテキストで`.search-status`が「登録単語数（3510語）」表示に変わるまでの時間を3回計測。1回目=4113ms、2回目=1137ms、3回目=1142ms。同一Node previewプロセスに対する計測で、1回目だけ約3.6倍遅い（`navigation` timingでも `domContentLoadedEventEnd` が1回目3029.5ms、2・3回目は約223msと大差）。3回とも新規ブラウザコンテキスト（HTTPキャッシュなし）のため、差はブラウザ側キャッシュではなくサーバー/OSディスクキャッシュのコールドスタートに起因すると推測される（未確認）。
- 再現手順: 1. `npm run build` 2. `npx vite preview --port 4176` 3. 新規ブラウザコンテキストでindexedDB削除→`/`にgoto→`.search-status`が「登録単語数」表示になるまでの経過時間を計測、を同一サーバープロセスに対し3回連続実行
- 証拠: `docs/review/agents/screenshots/performance/measure-log.json`の`seedImport`配列
- 影響: 個人用アプリでサーバー（プレビュー/実運用相当のプロセス）起動直後の最初のアクセスに限り体感4秒程度の待ちが発生しうる。2回目以降は1.1秒程度に収まる
- 確信度: 確認済み（数値は実測）。原因（コールドキャッシュ）は推測

## [2] 検索入力→再描画の遅延は平均180.9ms（169〜204ms、3510語全件スコアリング時）
- 種別: 目標未達 / 観点
- 画面: SearchScreen
- 現象: 検索欄に1文字ずつ入力し、キー入力タイムスタンプから結果リスト（`.search-results`）のDOM更新（MutationObserver検知）までの遅延を計測。5クエリ×文字ごと、計15サンプルで平均180.9ms、最小169ms、最大204ms（`useDebouncedValue`の150msデバウンス＋`termsRepo.getAll()`済み3510語全件に対する`score()`実行＋Reactの再描画コストの合計）。150ms設定値に対し実測は常にそれを上回り、超過分は約20〜54ms。
- 再現手順: 1. 検索画面表示（3510語ロード済み） 2. `.search-input`に1文字ずつ入力（`pressSequentially`, delay 0） 3. 各文字ごとにキー入力時刻と`.search-results`のDOM変化検知時刻の差を記録
- 証拠: `docs/review/agents/screenshots/performance/measure-log.json`の`searchLatency`配列
- 影響: 3510語全件を毎回スコアリングする設計（`docs/ui-pc.md`記載の意図どおり）のため、デバウンス150msに対し常に20〜50ms程度の追加遅延が乗る。単体では体感上大きな問題にはならない水準だが、語数が今後増えた場合は線形に悪化する設計である点は留意。
- 確信度: 確認済み

## [3] Google Fonts読み込みはFirst Contentful Paintの約1.5秒後に完了するが、CLSへの寄与は極小
- 種別: 観点
- 画面: 全画面共通（`index.html`でGoogle Fonts CDNを`display=swap`で読み込み）
- 現象: `first-contentful-paint`=308ms、`document.fonts.ready`解決=1827.8ms（差約1520ms）。この間はフォールバックフォントで描画されているためFOUTが発生している。一方、同じ観測ウィンドウで`PerformanceObserver({type:'layout-shift'})`が捕捉した`layout-shift`エントリの合計値（`hadRecentInput:false`のみ）は0.00283であり、一般的な「良好」しきい値（CLS<0.1）を大きく下回る。
- 再現手順: 1. 新規コンテキストでlayout-shift observerをinitScriptで先行登録 2. `/`にgoto 3. シード取り込み完了+1秒待機後に`performance.getEntriesByType('paint')`と蓄積された`layout-shift`エントリ、`document.fonts.ready`解決時刻を取得
- 証拠: `docs/review/agents/screenshots/performance/measure-log.json`の`fonts`オブジェクト、スクリーンショット`fonts-fout-check.png`
- 影響: FOUT自体（フォールバック→Webフォント切替の一瞬のちらつき）は発生するが、`BIZ UDPGothic`/`Noto Sans JP`と主要フォールバックのメトリクス差が小さいためか、実測ではレイアウトのガタつき（CLS）はほぼ皆無。視覚的な「ズレ」被害は小さいと判断できる。
- 確信度: 確認済み（CLS実測値・FCP/fonts.readyの実測値）。ちらつきの主観的な見え方はスクリーンショット1枚のみで動画観察はしていないため、体感の強さは推測

## [4] ビルド後バンドルは初期表示で約104KB(gzip)、シードJSONを含めると約275KB(gzip)
- 種別: 観点
- 画面: 全画面（初回ロード）
- 現象: `dist/`直下の生ファイルサイズは合計1.1MB（`index-DjXq9zHb.js` 304KB、`index-CCc5yMfP.css` 12KB、`index.html` 4KB、`seed/terms.json` 760KB）。`vite build`出力のgzipサイズはJS 100.50KB、CSS 2.83KB、HTML 0.40KB。`vite preview`は`seed/terms.json`を自動でgzip配信しており、実測の転送バイト数は約171KB（元760KBの約22%）。したがって初回起動時にJS+CSS+シードJSONを合計すると概算約275KB(gzip)がネットワーク転送される。
- 再現手順: 1. `du`相当でdistディレクトリの各ファイルサイズを確認 2. `node`の`http.get`で`Accept-Encoding: gzip`指定して`/seed/terms.json`を取得し、受信バイト数を実測
- 証拠: ビルドログ（本レポート作成時の`npm run build`標準出力）、`curl`/`node http.get`実行結果（本タスク内で実行、ファイル未保存・コマンド出力のみ）
- 影響: サーバーレス・個人用途としては軽量な部類。ネットワークが低速な環境（オフライン運用が前提のIndexedDBアプリだが、初回シード取得時のみオンライン相当の転送が必要）では初回のみ約275KB分の待ちが発生する。
- 確信度: 確認済み

## [5] 詳細画面遷移（検索結果クリック→用語詳細描画）は平均67.0ms（41〜90ms、5回計測）
- 種別: 目標未達 / 観点
- 画面: SearchScreen → TermDetailScreen
- 現象: 「セキュリティ」で検索→先頭結果クリックから、`.term-detail h2`にテキストが入るまでの時間を5回計測。41ms, 50ms, 86ms, 68ms, 90ms（平均67.0ms、最小41ms、最大90ms）。`TermDetailScreen`は`termsRepo.getById`と`notesRepo.getByTermId`の2つのIndexedDB非同期読み取りをPromise.allで待つ実装（コード確認済み: `src/ui/pc/TermDetailScreen.tsx:19-26`）のため、クリックのたびにIndexedDBアクセスが発生する。
- 再現手順: 1. 検索欄に「セキュリティ」入力、400ms待機 2. 先頭の`.search-result`クリック時刻を記録 3. `.term-detail h2`のテキストが埋まった時刻をMutationObserverで検知 4. 「検索に戻る」で戻り、5回繰り返し
- 証拠: `docs/review/agents/screenshots/performance/measure-log.json`の`detailTransition`配列
- 影響: 平均67ms・最大90msは体感上ほぼ気づかれない水準。Skeleton表示が挟まる設計だが、この程度の遅延ではSkeletonがちらついて見える可能性がある（別観点、機能性/UI領域のため本レポートでは数値報告のみに留める）。
- 確信度: 確認済み

---

## 確認できなかったこと
- **Lighthouseの標準指標（LCP・TBT・TTI・Speed Index等）は未計測。** Stage Bの`lhci autorun`がWindows環境のchrome-launcher一時ディレクトリ削除処理でEPERMが2回連続発生し完走しなかったため（`docs/review/logs/lhci.txt`）、本タスクは手動実測で代替したが、Lighthouseが算出する複合指標そのものは得られていない
- **シード取り込み1回目が遅い原因（4113ms vs 1137ms/1142ms）は未特定。** サーバー/OSディスクキャッシュのコールドスタートと推測したが、Node previewプロセスやWindowsファイルシステムキャッシュの挙動を直接検証してはいない
- **検索結果リストの再描画検知（MutationObserver, `childList:true`）は、DOM上のテキストのみが変化しノードの追加/削除が起きないケースを取りこぼす可能性がある。** 今回の15サンプルはいずれも2000msのフォールバックタイムアウトに達しておらず実測値として妥当と判断したが、方式自体にこの限界がある点は明記する
- **モバイル/低スペック端末での実測はしていない。** 開発機（Windows 11、具体的なCPU/メモリ性能は未計測環境情報として記録していない）上のPlaywright chromiumのみでの計測であり、実際のユーザー環境での体感を保証しない
- **回線速度をスロットリングした状態での計測はしていない。** ローカルプレビューサーバーへの直結のみで、実際のインターネット経由アクセス（初回シードJSON約171KB(gzip)のダウンロード時間）は未計測
- **フォントFOUTの主観的な視認性（実際にどれだけ「ちらつき」として気になるか）は動画等での確認をしておらず、静止画1枚とCLS数値のみからの判断**
- **3510語以上に語数が増えた場合の性能劣化カーブは未計測。** 現状語数（3510語）でのスナップショットのみ
