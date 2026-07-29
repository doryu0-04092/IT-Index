import type { AiClient } from '../ai/aiClient';
import { parseMergeResponse } from '../ai/parseMerge';
import { buildMergeMessages, MERGE_SYSTEM_PROMPT } from '../ai/prompts';
import type { NoteConflict } from '../core/mergeSnapshot';

/**
 * docs/requirements.md §5.5 の「同じ語の両端更新」用AI統合。輸送手段（Drive/手動）に
 * 依存しない。コミット時の育成統合（src/ai/distribution.ts）と同じプロンプト・パーサーを
 * 再利用する（どちらも「2つの本文を情報を欠落させず1つに統合する」という同じ操作のため）。
 * 出力は提案として返すだけで、DBへの適用は呼び出し側が承認を得てから行うこと。
 */
export async function resolveConflict(
  conflict: NoteConflict,
  claude: AiClient,
): Promise<{ body: string; diagrams: string[] } | null> {
  const messages = buildMergeMessages(
    conflict.termId,
    conflict.local.body,
    conflict.local.diagrams,
    conflict.remote.body,
    conflict.remote.diagrams,
  );
  const raw = await claude.send({ system: MERGE_SYSTEM_PROMPT, messages });
  const parsed = parseMergeResponse(raw);
  return parsed.ok ? parsed.result : null;
}
