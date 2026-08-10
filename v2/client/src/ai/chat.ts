import type { ChatRepository } from '../repositories/chat';
import type { AiClient, AiMessage } from './aiClient';
import { buildSubjectContextBlock, CHAT_SYSTEM_PROMPT } from './prompts';
import type { SubjectContext } from './subjectContext';

/**
 * 応答を控えた(stop_reason==="refusal")場合にtextが空になりうる契約
 * (v2\server\src\ai.ts「stop_reason==="refusal"は成功扱いで返す」)。会話履歴に空文字を
 * そのまま残すと利用者から見て何も起きていないように見えるため、案内文へ差し替える。
 */
export const REFUSAL_MESSAGE = 'AIが応答を控えました。別の聞き方を試してください。';

/**
 * docs/architecture.md §4.1「何度でも」のループ1回分(v1 ../../../src/ai/chat.ts参照。
 * 呼び出し経路がAIプロキシ経由になった以外は仕様を変えていない)。対話中はnotesを一切
 * 更新しない(確定時に1回だけ、という要件定義書§5.3の方針はai/distribution.ts側の責務)。
 */
export async function sendChatTurn(
  sessionId: string,
  userText: string,
  deps: { chatRepo: ChatRepository; aiClient: AiClient; subject?: SubjectContext },
  /** クイック質問の定型文かどうか。trueならチャット画面に表示しない(DBへ永続化する) */
  hideQuestion?: boolean,
): Promise<string> {
  // ユーザーが実際に入力したテキストには文脈付与の文字列を一切混ぜない。
  // 文脈は毎ターンsystem側で動的に組み立てる(docs/ai-client.md §2)。
  await deps.chatRepo.appendMessage(sessionId, 'user', userText, { hidden: hideQuestion });

  const history = await deps.chatRepo.getMessages(sessionId);
  const messages: AiMessage[] = history.map((m) => ({ role: m.role, content: m.content }));

  const system = deps.subject
    ? `${CHAT_SYSTEM_PROMPT}\n\n---\n現在の話題:\n${buildSubjectContextBlock(deps.subject)}`
    : CHAT_SYSTEM_PROMPT;

  const result = await deps.aiClient.send({ system, messages });
  const reply = result.stopReason === 'refusal' && result.text.trim() === '' ? REFUSAL_MESSAGE : result.text;

  await deps.chatRepo.appendMessage(sessionId, 'assistant', reply);
  await deps.chatRepo.touchSession(sessionId, Date.now());

  return reply;
}
