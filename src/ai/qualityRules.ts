/**
 * 品質基準の正本。API側システムプロンプト（`src/ai/prompts.ts` の
 * `DISTRIBUTION_SYSTEM_PROMPT`/`MERGE_SYSTEM_PROMPT`）が参照する。
 * 元は Claude Code によるローカルフォルダ編集（`AI_EDIT_GUIDE.md`）とも共有していたが、
 * その機能自体を廃止したため、現在はこの用途のみに使う（2026-08-03）。
 */
export function buildQualityRules(): string {
  return `- 初心者にも理解できる説明にする。専門用語が出てきたら簡潔に補足する
- 概要・仕組み・具体例を含める
- 技術的な正確性を優先する。分からないことを断定しない
- 文章量は詰め込みすぎない（1語について長すぎる説明は避ける）`;
}
