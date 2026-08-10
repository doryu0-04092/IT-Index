/**
 * 品質基準の正本(v1 ../../../src/ai/qualityRules.ts参照)。
 * `src/ai/prompts.ts`のDISTRIBUTION_SYSTEM_PROMPT/MERGE_SYSTEM_PROMPTが参照する。
 */
export function buildQualityRules(): string {
  return `- 初心者にも理解できる説明にする。専門用語が出てきたら簡潔に補足する
- 概要・仕組み・具体例を含める
- 技術的な正確性を優先する。分からないことを断定しない
- 文章量は詰め込みすぎない(1語について長すぎる説明は避ける)`;
}
