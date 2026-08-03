import { buildQualityRules } from './qualityRules';
import { FIELDS } from '../types';
import type { AiMessage } from './aiClient';
import type { SubjectContext } from './subjectContext';

/** 通常のチャット応答用。docs/requirements.md §5.2 の「分かるまでに必要だった情報」の思想をここでも踏襲する */
export const CHAT_SYSTEM_PROMPT = `あなたはIT-Indexという学習アプリのチャット相手です。相手は未経験のITエンジニアです。
前提知識が無くても理解できるよう、具体例やつまずきやすい点を交えて分かりやすく説明してください。
専門用語を使う場合は、初出時に簡単な補足を添えてください。`;

/**
 * docs/ai-client.md §2「文脈の自動付与」。SubjectContext から毎ターン動的に生成し、
 * CHAT_SYSTEM_PROMPT の末尾に追加する。ユーザーのメッセージ本文には一切手を加えない
 * （文脈をメッセージ内容へ文字列連結する旧方式は、話題変更のたびに新しい一文パッチが
 * 必要になる・会話履歴を汚染する、という理由で廃止した。docs/prompts.md 回帰ケース1参照）。
 */
export function buildSubjectContextBlock(subject: SubjectContext): string {
  if (subject.mode === 'free') {
    return subject.seedQuery
      ? `利用者は検索で「${subject.seedQuery}」を探していましたが、確定した用語ではありません。`
      : '(自由な質問)';
  }

  const parts = [`${subject.label}（分野: ${subject.field}、読み: ${subject.readings.join('/')}）`];
  if (subject.existingSummary) parts.push(`既存の初期説明:\n${subject.existingSummary}`);
  if (subject.existingNoteBody) parts.push(`既存のAI補足:\n${subject.existingNoteBody}`);
  parts.push(
    `この対話中「これ」「この」などの指示語は、断りが無い限り「${subject.label}」自身を指すものとして読んでください。`,
  );
  return parts.join('\n');
}

/**
 * docs/requirements.md §5.3「分配統合」。会話全体を渡した上で、この指示を最後に追加する
 * （architecture.md §4.1 シーケンス図の「会話全体＋既存のAI補足」に対応。既存のAI補足は
 * 分配統合の時点ではまだどの用語が該当するか分からないため、ここでは渡さず、
 * マッチした用語ごとに src/ai/distribution.ts が個別に MERGE_SYSTEM_PROMPT で統合する）
 */
export const DISTRIBUTION_INSTRUCTION =
  '以上の会話を踏まえて、話題に上ったIT用語ごとに情報を分配統合してください。出力はJSON配列のみとし、前後に説明文を書かないでください。';

export const DISTRIBUTION_SYSTEM_PROMPT = `あなたはIT-Indexという学習アプリの一部です。ユーザーとの会話を振り返り、話題に上ったIT用語ごとに情報を切り分けます。

出力は次のJSON配列のみとしてください。前後に説明文やコードフェンス以外の文章を書かないでください。

[
  {
    "term": "見出し語（例: TCP/IP）",
    "isTerm": true,
    "askedByUser": true,
    "summary": "この語を簡潔に言い表す一文（初期説明。分かる人が見れば足りるレベルの短さ）",
    "readings": ["カタカナ読み。原則1要素"],
    "field": "分野。次のいずれか1つ: ${FIELDS.join(', ')}",
    "draftBody": "この語について会話から起こした、単独で読んで理解できる完結した説明文（Markdown）",
    "diagrams": ["Mermaid記法の図。無ければ空配列"]
  }
]

ルール:
- term は簡潔な見出し語・熟語のみにしてください（例: TCP/IP、SQLインジェクション）。ユーザーが検索欄に入力した質問文や、会話中の質問の文言をそのまま複写しないでください。文や疑問形になっている場合は、それが指している用語・熟語だけを抜き出してください。
- 会話中でIT用語ではないもの（雑談など）を項目に含める場合は isTerm を false にしてください。isTerm が false の項目は term と diagrams（空配列でよい）だけを書き、readings・field・draftBody・askedByUser・summary は書かないでください。
- isTerm が true の項目には必ず askedByUser を含めてください。**ユーザー自身がその語について説明・意味・詳細を尋ねる発言をした場合のみ true** にしてください。あなた（AI）が別の語を説明する過程で、ユーザーから特に聞かれていないのに触れただけの語は false にしてください。ユーザーが「これ」「この」等の指示語で尋ねた場合、指し先の語（会話冒頭の文脈で示された語、または直前にAIが説明した語）も true として扱ってください。
- summary は一文の要約であり、draftBody（前提知識・具体例を含む詳しい説明）とは役割が違います。**summary に draftBody の内容を重複して長く書かないでください。** summary はこの語が辞書に新規登録される場合にのみ使われ、既に辞書にある語では（AIが何を書いても）無視されます。
- draftBody は「分からなかった人が、分かるようになるまでに必要だった情報」の記録として書いてください。前提知識・具体例・つまずきやすい点を含め、この文章だけを読んで理解できるようにしてください。読み手が既に知識を持っている前提で書かないでください。
- 同じ用語が会話中に何度も出てきても、1項目にまとめてください（一度でもユーザーに聞かれていれば askedByUser は true）。
- 用語が1つも無い会話なら、空配列 [] を返してください。

summary・draftBody に共通の品質基準（docs/local-data.md。Claude Code によるファイル編集にも同じ基準を課している）:
${buildQualityRules()}`;

export function buildDistributionMessages(history: AiMessage[]): AiMessage[] {
  return [...history, { role: 'user', content: DISTRIBUTION_INSTRUCTION }];
}

/**
 * docs/requirements.md §5.5 の「両端末で更新された語」統合と同じ能力を、
 * コミット時の「既存のAI補足に育てて追記する」場面でも再利用する（src/ai/distribution.ts）。
 */
export const MERGE_SYSTEM_PROMPT = `あなたはIT-Indexという学習アプリの一部です。同じ用語について、既存の説明と新しい説明を渡すので、情報を欠落させずに1つの説明文に統合してください。

出力は次のJSONオブジェクトのみとしてください。前後に説明文を書かないでください。

{
  "body": "統合後の説明文（Markdown）。単独で読んで理解できる完結した文章にしてください",
  "diagrams": ["Mermaid記法の図の配列。既存と新規のうち有用なものを残してください"]
}

ルール:
- 既存の説明にある情報を勝手に削らないでください。重複は整理してよいですが、要約して薄めないでください。
- 新しい説明で判明した情報（つまずきやすい点、具体例など）を優先的に残してください。

品質基準（docs/local-data.md。Claude Code によるファイル編集にも同じ基準を課している）:
${buildQualityRules()}`;

export function buildMergeMessages(
  term: string,
  oldBody: string,
  oldDiagrams: string[],
  newBody: string,
  newDiagrams: string[],
): AiMessage[] {
  const content = `用語: ${term}

## 既存の説明
${oldBody}

## 既存の図
${oldDiagrams.length > 0 ? oldDiagrams.join('\n---\n') : '(なし)'}

## 新しい説明
${newBody}

## 新しい図
${newDiagrams.length > 0 ? newDiagrams.join('\n---\n') : '(なし)'}`;

  return [{ role: 'user', content }];
}
