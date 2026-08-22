import type { NoteRecord } from '@it-index/shared';
import type { AiClient } from './aiClient';
import { parseMergeResponse } from './parseMerge';
import { buildUnifiedMergeMessages, UNIFIED_MERGE_SYSTEM_PROMPT } from './prompts';

/**
 * **1回のAI呼び出しで、この端末＋相手全部を統一する(#238)。**
 *
 * 相手ごとに統合すると、(1)要約の要約で情報が薄まる (2)決定が複数回に分かれて相手が収束しない、
 * の2つが起きる。実機で報告された「どちらも採用中なのにAndroidの競合が解消されない」はこれ。
 *
 * **システムプロンプトはAI確定(分配統合)と分けてある。** あちらは「既存の説明＋新しい説明」の
 * 2版で、こちらは「複数の端末それぞれの説明」。前提が違うものを1つのプロンプトで兼ねると、
 * 片方を直した時にもう片方が壊れる(#238の実装中に実際にやってしまった)。
 *
 * 出力は提案として返すだけで、DBへの適用は呼び出し側が行う。
 * **解釈できなければ null を返す**——呼び出し側はその場合**何も適用しない**
 * (一部だけ適用すると、決定が分裂して相手が収束しない)。
 *
 * エラーは呼び出し元にそのまま投げる(未ログイン・license_required・上限などを
 * ApiRequestError.code で判別する既存の経路に AiClient.send が乗っているため)。
 *
 * @param others 相手端末の版。表示上の上限で畳まれた分も含め全件渡すこと
 */
export async function resolveConflictAll(
  termId: string,
  local: NoteRecord,
  others: NoteRecord[],
  aiClient: AiClient,
): Promise<{ body: string; diagrams: string[] } | null> {
  const messages = buildUnifiedMergeMessages(
    termId,
    local.body,
    local.diagrams,
    others.map((o) => ({ body: o.body, diagrams: o.diagrams })),
  );
  const result = await aiClient.send({ system: UNIFIED_MERGE_SYSTEM_PROMPT, messages });
  const parsed = parseMergeResponse(result.text);
  return parsed.ok ? parsed.result : null;
}
