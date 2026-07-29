import type { ChatRepository } from '../repositories/chat';
import type { AiClient, AiMessage } from './aiClient';
import { CHAT_SYSTEM_PROMPT } from './prompts';

/**
 * docs/architecture.md §4.1「何度でも」のループ1回分。
 * 対話中は notes を一切更新しない（確定時に1回だけ、という要件定義書 §5.3 の方針は
 * src/ai/distribution.ts 側の責務であり、ここでは触れない）。
 */
export async function sendChatTurn(
  sessionId: string,
  userText: string,
  deps: { chatRepo: ChatRepository; claude: AiClient; termLabel?: string },
): Promise<string> {
  const existing = await deps.chatRepo.getMessages(sessionId);

  // 用語詳細画面から始めたチャット（termLabelあり）の最初の1通だけ、文脈を冒頭へ付けてAIへ渡す。
  // これが無いと、AIは「今どの用語について聞かれているか」を利用者の文面だけから
  // 推測するしかなく、認識できないことがあった（実際に報告された不具合）。
  // 2通目以降は会話履歴自体に文脈が残るため付けない。フリーチャット（termLabel無し）にも付けない。
  //
  // 単に「〇〇についての質問です。」と一文添えるだけでは不十分だった（実際に報告された不具合）。
  // 「これ」「この」等の指示語を含む質問（例:「これはどういうもの？」）を続けると、AIは
  // その一文を「話題の説明」としか読まず、直後の指示語が話題そのものを指しているとは
  // 解釈しなかった（「これ」＝何か別に提示されるはずのコマンドやエラーメッセージ、と誤読する）。
  // そこで、指示語の解決先を明示的に指定する一文を加える。
  const isFirstMessage = existing.length === 0;
  const textToSend =
    isFirstMessage && deps.termLabel
      ? `「${deps.termLabel}」についての質問です。以下の質問文中の「これ」「この」などの指示語は、断りが無い限り「${deps.termLabel}」自身を指すものとして読んでください。\n\n${userText}`
      : userText;

  await deps.chatRepo.appendMessage(sessionId, 'user', textToSend);

  const history = await deps.chatRepo.getMessages(sessionId);
  const messages: AiMessage[] = history.map((m) => ({ role: m.role, content: m.content }));

  const reply = await deps.claude.send({ system: CHAT_SYSTEM_PROMPT, messages });

  await deps.chatRepo.appendMessage(sessionId, 'assistant', reply);
  await deps.chatRepo.touchSession(sessionId, Date.now());

  return reply;
}
