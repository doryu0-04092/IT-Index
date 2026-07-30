import { FIELDS } from '../types';

/**
 * 品質基準の正本（docs/local-data.md §2 と対応）。
 * Claude Code 向け（`AI_EDIT_GUIDE.md`）と API 側システムプロンプト（`src/ai/prompts.ts` の
 * `DISTRIBUTION_SYSTEM_PROMPT`/`MERGE_SYSTEM_PROMPT`）の両方がこの1つの文言を参照する。
 * どちらの経路で書かれた説明も同じ基準になるようにするための、二重管理を避ける唯一の置き場所。
 *
 * ファイル形式・編集可否など「ファイル編集特有」の指示はここに含めない
 * （API側には`data/terms.json`という概念自体が無いため）。それらは `buildAiEditGuideFile()` 側にのみ書く。
 */
export function buildQualityRules(): string {
  return `- 初心者にも理解できる説明にする。専門用語が出てきたら簡潔に補足する
- 概要・仕組み・具体例を含める
- 技術的な正確性を優先する。分からないことを断定しない
- 文章量は詰め込みすぎない（1語について長すぎる説明は避ける）`;
}

/** `AI_EDIT_GUIDE.md` 全体（フォルダ構成の説明を含む）。初回セットアップ時にフォルダへ書き出す */
export function buildAiEditGuideFile(): string {
  return `# AI_EDIT_GUIDE

このフォルダは IT-Index（IT用語集アプリ）の個人データです。Claude Code などのAIエージェントは、このファイルの規約に従ってフォルダ内のファイルを編集してください。

## フォルダ構成

\`\`\`
data/terms.json      … 単語データ（あなたが追加・変更した語のみ。元から入っている語は含まれません）
data/notes/*.md       … 各語の詳しい説明（1語1ファイル）
backups/              … アプリが自動で作るバックアップ。編集しない
\`\`\`

## 編集してよい場所・してはいけない場所

- \`data/terms.json\`: 新しい語の追加、既存語の \`readings\`（読み）・\`field\`（分野）・\`tags\`（任意）の修正はしてよい。
- \`data/notes/<語のid>.md\`: **front matter（\`---\` で囲まれた先頭部分）より下の本文が編集対象。** ここに理解のための詳しい説明を書く。図が要る場合は \`\`\`mermaid フェンスで書く。
- **\`data/terms.json\` の \`summary\` は変更しない。** front matter の \`summary\` も同様（参照専用、編集しても反映されない）。1〜2文で「思い出すための要約」という役割が決まっており、書き換えるとアプリの他の設計と矛盾する。
- \`data/terms.json\` の既存の行を削除しない。削除は「その語をアプリから消す」ことを意味する。

## \`data/terms.json\` の形式

\`\`\`json
{ "term": "見出し語", "readings": ["読み（カタカナ）"], "summary": "（触らない）", "field": "分野", "tags": ["任意"] }
\`\`\`

- \`term\`: ファイル内で重複させない
- \`readings\`: カタカナで1つ。英数字の語にも読みを付ける（例: API → エーピーアイ）
- \`field\`: 次の一覧から必ず選ぶ（自由記述にしない）
  ${FIELDS.join(' / ')}
- キー名を変更しない。構造を変更しない

## \`data/notes/<id>.md\` の形式

\`\`\`markdown
---
term: 参照用（編集しても反映されない）
field: 参照用
summary: 参照用
updatedAt: 参照用
---

ここが編集対象。初心者にも分かるように、前提知識・具体例を含めて説明する。

\`\`\`mermaid
graph LR
  A --> B
\`\`\`
\`\`\`

## 品質基準

${buildQualityRules()}

## 編集後

- \`data/terms.json\` の \`version\` を \`YYYY-MM-DD\` 形式で更新する（アプリは実際にはファイルの更新時刻でも変更を検知するが、\`version\` は人が読む記録として役立つ）
- アプリを再読み込みすれば変更が反映される
`;
}
