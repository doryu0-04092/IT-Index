import type { ChatRepository } from '../repositories/chat';
import type { AiClient, AiMessage } from './aiClient';
import { buildSubjectContextBlock, CHAT_SYSTEM_PROMPT } from './prompts';
import type { SubjectContext } from './subjectContext';

/**
 * docs/architecture.md §4.1「何度でも」のループ1回分。
 * 対話中は notes を一切更新しない（確定時に1回だけ、という要件定義書 §5.3 の方針は
 * src/ai/distribution.ts 側の責務であり、ここでは触れない）。
 */
export async function sendChatTurn(
  sessionId: string,
  userText: string,
  deps: { chatRepo: ChatRepository; claude: AiClient; subject?: SubjectContext },
): Promise<string> {
  // ユーザーが実際に入力したテキストには文脈付与の文字列を一切混ぜない。
  // 文脈は毎ターン system 側で動的に組み立てる（docs/ai-client.md §2）。
  await deps.chatRepo.appendMessage(sessionId, 'user', userText);

  const history = await deps.chatRepo.getMessages(sessionId);
  const messages: AiMessage[] = history.map((m) => ({ role: m.role, content: m.content }));

  const system = deps.subject
    ? `${CHAT_SYSTEM_PROMPT}\n\n---\n現在の話題:\n${buildSubjectContextBlock(deps.subject)}`
    : CHAT_SYSTEM_PROMPT;

  const reply = await deps.claude.send({ system, messages });

  await deps.chatRepo.appendMessage(sessionId, 'assistant', reply);
  await deps.chatRepo.touchSession(sessionId, Date.now());

  return reply;
}
