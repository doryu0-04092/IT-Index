# IT-Index

IT用語をかな・カタカナ・英字のどれでも検索できる、個人用のIT用語辞書アプリです。ブラウザだけで動作し、サーバーは使いません（データはすべてブラウザのIndexedDBに保存されます）。

## できること

- **検索**: 内蔵の3510語（IPAシラバス24分類）を、読み・カタカナ・英字のどれで入力しても検索できます
- **AIチャット**: 用語について質問すると、AIが調べた内容を「理解のための補足」として蓄積します（Anthropic Claude / OpenAI / Google Geminiのいずれかの、ご自身のAPIキーが必要です）
- **ローカルフォルダ連携（Claude Code等での編集）**: PCに保存したフォルダをアプリと接続すると、そのフォルダの中身をClaude CodeなどのAIエージェントが直接編集でき、アプリ側にもそのまま反映されます。詳しくは下記「Claude Codeとの連携」を参照してください
- **ライト/ダークモード切り替え**

## セットアップ

```sh
npm install
npm run dev
```

`http://localhost:5173` を開くと起動します。PC版Chrome/Edgeでの利用を想定しています（ローカルフォルダ連携はFile System Access APIを使うため、この2つ以外のブラウザでは使えません）。

## Claude Codeとの連携

このアプリはAIをアプリ内部に埋め込むのではなく、**利用者が既に契約しているClaude Code（またはClaude）を「ローカルファイルを編集するAI編集者」として使う**、という設計を取っています。

### 使い方

1. アプリ起動直後に出るバナー、または設定画面から「フォルダを作成」を押し、PC上の好きな場所にフォルダを1つ選びます
2. 選んだフォルダの中に、`data/terms.json`・`data/notes/*.md`・`AI_EDIT_GUIDE.md` が自動生成されます
3. そのフォルダに対して、次の2通りの方法でAIに単語を編集させられます

**① アプリの「AIに聞く」から質問した内容をClaude Codeに処理させる**

用語詳細画面や検索結果から「この語について聞く」でAIチャットを行うと、確定する前のやり取りが `data/pending/<語のid>.md` として自動的に書き出されます。Claude Codeにそのフォルダを開かせて「pendingフォルダの中身を処理して」のように指示すると、そのやり取りをもとに `data/terms.json`・`data/notes/<語のid>.md` を編集してくれます。処理が終わるとpendingファイルは自動的に削除され、アプリ側の「確定待ち」表示も自動的に消えます。

**② アプリのチャットUIを経由せず、Claude Codeに直接聞く**

`AI_EDIT_GUIDE.md` の規約はpendingファイルの処理に限定されていません。**アプリを一切開かず、Claude Codeとの会話だけで新しいIT用語を追加したり、既存語の説明を書いてもらうことも可能です。** 「〇〇という用語をこのフォルダに追加して」のように直接依頼すれば、Claude Codeが `data/terms.json` に新語を追加し、`data/notes/<語のid>.md` に説明を書き込みます。アプリを開いて再読み込みすれば反映されます。

いずれの方法でも、**元から内蔵されている3510語の要約（`summary`）はAIが書き換えません**（一度書かれたら不変というルールになっています）。AIが書けるのは「理解のための補足説明」（`data/notes/*.md`）と、新しく追加する語だけです。

### 対応環境の制約

ローカルフォルダ連携（File System Access API）はPC版Chrome/Edgeのみ対応です。それ以外の環境では、この機能を隠してAI検索・AIチャット・検索機能のみが使えます。

## 開発

コマンド一覧は `package.json` の `scripts` を参照してください（`npm run build`・`npm test` 等）。

設計・仕様の詳細ドキュメントは `docs/` 配下にあります。特に以下が中心的なドキュメントです。

- `docs/requirements.md` — 要件定義
- `docs/architecture.md` — アーキテクチャ全体
- `docs/data-layer.md` — データ層の設計
- `docs/seed-format.md` — 内蔵単語データの形式
- `docs/local-data.md` — ローカルフォルダ連携（Claude Code連携）の設計
- `docs/ai-client.md` / `docs/prompts.md` — AIチャット・API連携の設計
