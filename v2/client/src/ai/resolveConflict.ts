import type { NoteRecord } from '@it-index/shared';
import type { AiClient } from './aiClient';
import { parseMergeResponse } from './parseMerge';
import { buildMergeMessages, buildUnifiedMergeMessages, MERGE_SYSTEM_PROMPT } from './prompts';

/**
 * v1(../../../src/sync/resolveConflict.ts)の移植。同じ語について両端末で更新していた場合の
 * 「AIで統合する」用(要件定義書§5.5)。v1との差分はAiClientの契約のみ——v1のsend()は
 * Promise<string>を返すが、v2のsend()はAiSendResult({ text, stopReason, usage })を返す
 * (../aiClient.ts参照)。ここではtextだけを使う。
 *
 * 出力は提案として返すだけで、DBへの適用は呼び出し側(SyncScreen)が行う。エラーは
 * 呼び出し元にそのまま投げる(未ログイン・license_required・上限などをApiRequestError.code
 * で判別する既存の経路にAiClient.sendが乗っているため。ai/aiClient.ts参照)。
 */
/**
 * **1回のAI呼び出しで、この端末＋相手全部を統一する(#238)。**
 *
 * 相手ごとに統合すると、(1)要約の要約で情報が薄まる (2)決定が複数回に分かれて相手が収束しない、
 * の2つが起きる。実機で報告された「どちらも採用中なのにAndroidの競合が解消されない」はこれ。
 *
 * 出力は提案として返すだけで、DBへの適用は呼び出し側が行う。
 * **解釈できなければ null を返す**——呼び出し側はその場合**何も適用しない**
 * (一部だけ適用すると、いまと同じ不整合になる)。
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
  const result = await aiClient.send({ system: MERGE_SYSTEM_PROMPT, messages });
  const parsed = parseMergeResponse(result.text);
  return parsed.ok ? parsed.result : null;
}

export async function resolveConflict(
  termId: string,
  local: NoteRecord,
  remote: NoteRecord,
  aiClient: AiClient,
): Promise<{ body: string; diagrams: string[] } | null> {
  const messages = buildMergeMessages(termId, local.body, local.diagrams, remote.body, remote.diagrams);
  const result = await aiClient.send({ system: MERGE_SYSTEM_PROMPT, messages });
  const parsed = parseMergeResponse(result.text);
  return parsed.ok ? parsed.result : null;
}
