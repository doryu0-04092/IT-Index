import { FIELDS } from '@it-index/shared';
import { buildQualityRules } from './qualityRules';
import type { AiMessage } from './aiClient';
import type { SubjectContext } from './subjectContext';

/**
 * プロンプト本文はすべてv1(../../../src/ai/prompts.ts)からそのまま移植する
 * (依頼書「system本文をそのまま使う。変更しない」)。v2との差分は、AiMessageの型が
 * v2\client\src\ai\aiClient.tsのもの(プロバイダ非依存のプロキシ経路用)に変わった点のみ。
 */
export const CHAT_SYSTEM_PROMPT = `あなたはIT-Indexという学習アプリのチャット相手です。相手は未経験のITエンジニアです。
前提知識が無くても理解できるよう、具体例やつまずきやすい点を交えて分かりやすく説明してください。
専門用語を使う場合は、初出時に簡単な補足を添えてください。`;

/**
 * docs/ai-client.md §2「文脈の自動付与」。SubjectContextから毎ターン動的に生成し、
 * CHAT_SYSTEM_PROMPTの末尾に追加する。ユーザーのメッセージ本文には一切手を加えない。
 */
export function buildSubjectContextBlock(subject: SubjectContext): string {
  if (subject.mode === 'query') {
    return [
      `利用者がホーム画面の検索欄に入力した言葉:「${subject.label}」`,
      `この言葉について説明してください。IT用語であればその用語の説明を、質問文であればその質問への回答を返してください。`,
      `この対話中「これ」「この」などの指示語は、断りが無い限り「${subject.label}」自身を指すものとして読んでください。`,
    ].join('\n');
  }

  const parts = [`${subject.label}（分野: ${subject.field}、読み: ${subject.readings.join('/')}）`];
  if (subject.existingSummary) parts.push(`既存の初期説明:\n${subject.existingSummary}`);
  if (subject.existingNoteBody) parts.push(`既存のAI補足:\n${subject.existingNoteBody}`);
  parts.push(
    `この対話中「これ」「この」などの指示語は、断りが無い限り「${subject.label}」自身を指すものとして読んでください。`,
  );
  return parts.join('\n');
}

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
- term は**その用語の一般的な正式表記**にしてください。ユーザーの入力に打ち間違い・かな書き・表記の揺れがあっても、それをそのまま写さず正しい表記に直してください（例:「SQLインジェクッション」→「SQLインジェクション」、「ティーシーピーアイピー」→「TCP/IP」、「ぜろとらすと」→「ゼロトラスト」）。ユーザーが用語名そのものを取り違えている場合も、会話の中で実際に説明した用語の正式名を term にしてください。
- 会話中でIT用語ではないもの（雑談など）を項目に含める場合は isTerm を false にしてください。isTerm が false の項目は term と diagrams（空配列でよい）だけを書き、readings・field・draftBody・askedByUser・summary は書かないでください。
- isTerm が true の項目には必ず askedByUser を含めてください。**ユーザー自身がその語について説明・意味・詳細を尋ねる発言をした場合のみ true** にしてください。あなた（AI）が別の語を説明する過程で、ユーザーから特に聞かれていないのに触れただけの語は false にしてください。ユーザーが「これ」「この」等の指示語で尋ねた場合、指し先の語（会話冒頭の文脈で示された語、または直前にAIが説明した語）も true として扱ってください。
- summary は一文の要約であり、draftBody（前提知識・具体例を含む詳しい説明）とは役割が違います。**summary に draftBody の内容を重複して長く書かないでください。** summary はこの語が辞書に新規登録される場合にのみ使われ、既に辞書にある語では（AIが何を書いても）無視されます。
- draftBody は「分からなかった人が、分かるようになるまでに必要だった情報」の記録として書いてください。前提知識・具体例・つまずきやすい点を含め、この文章だけを読んで理解できるようにしてください。読み手が既に知識を持っている前提で書かないでください。
- 同じ用語が会話中に何度も出てきても、1項目にまとめてください（一度でもユーザーに聞かれていれば askedByUser は true）。
- 用語が1つも無い会話なら、空配列 [] を返してください。

summary・draftBody に共通の品質基準:
${buildQualityRules()}`;

/**
 * subjectLabel: セッションの主題(利用者が選んだ語、または「AIで検索」に打った文字列)。
 * 渡すと、この語を分配統合の判定(isTerm・askedByUser)から独立して必ず含めるよう指示する。
 */
export function buildDistributionMessages(history: AiMessage[], subjectLabel?: string | null): AiMessage[] {
  const instruction = subjectLabel
    ? `${DISTRIBUTION_INSTRUCTION}\nなお、この会話の主題は「${subjectLabel}」です。話題として成立するかどうかの判断に関わらず、必ずこの語を1項目として含め、isTermをtrue、askedByUserをtrueにしてください（termは表記の揺れを正した正式名にしてよい）。`
    : DISTRIBUTION_INSTRUCTION;
  return [...history, { role: 'user', content: instruction }];
}

export const MERGE_SYSTEM_PROMPT = `あなたはIT-Indexという学習アプリの一部です。同じ用語について、既存の説明と新しい説明を渡すので、情報を欠落させずに1つの説明文に統合してください。

出力は次のJSONオブジェクトのみとしてください。前後に説明文を書かないでください。

{
  "body": "統合後の説明文（Markdown）。単独で読んで理解できる完結した文章にしてください",
  "diagrams": ["Mermaid記法の図の配列。既存と新規のうち有用なものを残してください"]
}

ルール:
- 既存の説明にある情報を勝手に削らないでください。重複は整理してよいですが、要約して薄めないでください。
- 新しい説明で判明した情報（つまずきやすい点、具体例など）を優先的に残してください。

品質基準:
${buildQualityRules()}`;

/**
 * 端末間の競合を統一する時のシステムプロンプト(#238)。
 *
 * **AI確定(分配統合)の `MERGE_SYSTEM_PROMPT` とは分ける。** あちらは
 * 「既存の説明 + 新しい説明」の2版で、こちらは「複数の端末それぞれの説明」。
 * 前提が違うものを1つのプロンプトで兼ねると、片方を直した時にもう片方が壊れる
 * (実際に #238 で MERGE_SYSTEM_PROMPT を端末向けに書き換え、AI確定の文脈と
 * 食い違わせてしまった)。
 */
export const UNIFIED_MERGE_SYSTEM_PROMPT = `あなたはIT-Indexという学習アプリの一部です。同じ用語について、複数の端末それぞれの説明を渡すので、情報を欠落させずに1つの説明文に統合してください。

出力は次のJSONオブジェクトのみとしてください。前後に説明文を書かないでください。

{
  "body": "統合後の説明文（Markdown）。単独で読んで理解できる完結した文章にしてください",
  "diagrams": ["Mermaid記法の図の配列。各端末の図のうち有用なものを残してください"]
}

ルール:
- **渡されたすべての説明の情報を残してください。** 重複は整理してよいですが、要約して薄めないでください。
- どれか1つを選ぶのではなく、**全部の内容が入った1つの説明**にしてください。
- それぞれの端末で判明した情報（つまずきやすい点、具体例など）を優先的に残してください。

品質基準:
${buildQualityRules()}`;

/**
 * 全端末の内容を1回で統一するためのプロンプト(#238)。
 *
 * **相手ごとに2版ずつ統合してはいけない。** 1回目の統合結果を2回目でもう一度AIに通すと
 * **要約の要約になって情報が薄まる**うえ、決定が複数回に分かれて相手端末が収束しない
 * (実機で報告された: PC + Android2台で両方統合したら、どちらも「採用中」になったのに
 * Androidの競合が解消されなかった)。
 *
 * @param others 相手端末の版。**表示上の上限で畳まれた分も含め全件渡す**(情報を落とさない)
 */
export function buildUnifiedMergeMessages(
  term: string,
  localBody: string,
  localDiagrams: string[],
  others: { body: string; diagrams: string[] }[],
): AiMessage[] {
  const joinDiagrams = (diagrams: string[]) =>
    diagrams.length > 0 ? diagrams.join('\n---\n') : '(なし)';
  const section = (title: string, body: string, diagrams: string[]) =>
    `## ${title}の説明
${body}

## ${title}の図
${joinDiagrams(diagrams)}`;

  const parts = [
    `用語: ${term}`,
    section('この端末', localBody, localDiagrams),
    ...others.map((o, i) => section(`別の端末${i + 1}`, o.body, o.diagrams)),
  ];

  return [{ role: 'user', content: parts.join('\n\n') }];
}

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
