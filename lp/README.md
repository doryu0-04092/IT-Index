# lp/ — 広告兼インストール用ランディングページ

`index.html` 単体で完結する静的ページ。ビルド不要でブラウザで直接開ける。
アプリ本体(v2/)には一切依存しない。

## スクリーンショットの差し替え方

アプリのUIが変わったら、`assets/` の**同名PNGを上書きするだけ**でよい(HTMLの変更は不要)。

### 撮影条件(全画像共通)

- 起動: `v2/` で `npm run dev -w client` → 表示されたlocalhost URLを開く
- ブラウザウィンドウ(ビューポート)を **390×844** にリサイズ(DevToolsのデバイスモードでも可)
- ライトテーマ、日本語UI
- 保存形式: PNG(現行は500×844で保存されている。多少の差異は `width/height` 属性で吸収される)

### 各画像の撮影状態

| ファイル | 画面 | 状態 |
|---|---|---|
| `assets/search.png` | 検索タブ | 検索欄に「DNS」を入力し、候補ドロップダウンが開いた状態 |
| `assets/detail.png` | 用語詳細(DNS) | 「理解のために調べたこと」に短い学習メモを保存した状態 |
| `assets/weighted.png` | 履歴タブ→重み付け | 事前に4〜5語を検索・閲覧して履歴を作っておく(DNSを2回開くと上位に来る) |
| `assets/index.png` | 索引タブ | 先頭(A〜Z・五十音グリッドが見える位置) |

### 注意

- オンボーディングモーダルは閉じてから撮影する
- 履歴・ノートは撮影用の実データを作ってから撮る(合成しない)
- APKのダウンロードURLはリリース更新時に `index.html` 内の2箇所(#install と最下部CTA)を差し替え、単一ファイル版(下記)も作り直してリリースに添付し直すこと

## 端末による導線の出し分け

`<head>` の3行のスクリプトが UserAgent を見て、Android実機の時だけ `<html data-os="android">` を立てる。
CSS 側はこの属性を見て、Android向けの導線を主・PC向けを従に入れ替える(`html[data-os="android"]` のブロック)。

| 入れ替わるもの | 既定(PC / iPhone等) | Android実機 |
|---|---|---|
| ヒーロー・最下部のCTA | 「ブラウザで今すぐ使う」が塗り(主) | 「Android版を入れる」が塗り(主) |
| 「はじめかた」の2枚のカード | PC / ブラウザ が先 | Android が先 |

- 主従の対象は `.btn-web` / `.btn-android` クラスと `#install-android` id で指定している。**CTAを増やす時は同じクラスを付ける**(付け忘れると入れ替わらない)
- 幅ではなくUAで判定している。幅で判定すると、APKを入れられないiPhoneにAPKを主で見せてしまうため
- JSが無効な環境では属性が立たず、既定(PC向け)の並びのままになる

## リリース添付用の単一ファイル版

GitHubリリースの添付ファイルはファイル単位でしか配れないため、`index.html` をそのまま
上げると `assets/` の画像が全て壊れる。画像を data URI に埋め込んだ自己完結版を生成して添付する。

```
node lp/build-standalone.mjs
```

- 出力: `lp/dist/it-index-start.html`(約420KB)。`dist/` は `.gitignore` 対象でコミットしない
- 生成時に相対参照が残っていないか検査し、残っていればエラーで停止する
- 添付: `gh release upload <タグ> lp/dist/it-index-start.html --clobber`

利用者はこのHTMLをダウンロードして開くだけで、「ブラウザで今すぐ使う」からWeb版へ、
「APKをダウンロード」からAndroid版のインストールへ進める。

> `index.html` を直したら生成物も作り直してリリースに上げ直すこと(生成物側だけを直さない)。

## Web配信(公式ホストの /lp/)

`v2` の `npm run deploy` がビルド後に `node ../lp/copy-to-dist.mjs` を実行し、
`index.html` と `assets/` を `v2/client/dist/lp/` へコピーしてWorkerの静的アセットとして配信する。

- 公開URL: **https://it-index.doryu.workers.dev/lp/**
- LPを更新したら `cd v2 && npm run deploy` だけで反映される(専用の手順なし)
- リリース添付用の単一ファイル版(上記)とは別物: Web配信は画像を別ファイルのまま配る(キャッシュが効く)
