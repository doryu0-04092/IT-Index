import type { NoteRecord } from '@it-index/shared';
import type { AiClient } from './aiClient';
import { parseMergeResponse } from './parseMerge';
import { buildMergeMessages, MERGE_SYSTEM_PROMPT } from './prompts';

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
