import type { ChatRepository } from '../repositories/chat';
import type { ChatSessionRecord } from '../types';
import type { AiClient, AiMessage } from './aiClient';
import { buildSubjectContextBlock, CHAT_SYSTEM_PROMPT } from './prompts';
import type { SubjectContext } from './subjectContext';

/**
 * 応答を控えた(stop_reason==="refusal")場合にtextが空になりうる契約
 * (v2\server\src\ai.ts「stop_reason==="refusal"は成功扱いで返す」)。会話履歴に空文字を
 * そのまま残すと利用者から見て何も起きていないように見えるため、案内文へ差し替える。
 * refusalも「返答が返ってきた」扱いで会話に保存する(#132本人決定)。
 */
export const REFUSAL_MESSAGE = 'AIが応答を控えました。別の聞き方を試してください。';

export interface SendChatTurnResult {
  reply: string;
  /** このターンを保存したセッションのID(下書きから作られた場合は新規作成されたID) */
  sessionId: string;
}

/**
 * docs/architecture.md §4.1「何度でも」のループ1回分(v1 ../../../src/ai/chat.ts参照)。
 * 対話中はnotesを一切更新しない(確定時に1回だけ、という要件定義書§5.3の方針は
 * ai/distribution.ts側の責務)。
 *
 * 保存順(#132本人決定): AI応答の受信に成功した時点で初めて「セッション作成(下書き時)→
 * 質問→返答」の順にDBへ書く。AI呼び出しが失敗した場合はDBに何も書かれないため、
 * 返答の無い会話が「取り込み待ち」一覧や履歴に登録用情報として残らない。
 * 失敗後の再送信で同じ質問が二重保存される問題もこの順序で防ぐ。
 *
 * @param sessionId 既存セッションのID。null=下書き(まだセッションが無い)。nullの場合は
 *   deps.createSessionが必須で、AI応答の受信成功後に呼ばれる。
 */
export async function sendChatTurn(
  sessionId: string | null,
  userText: string,
  deps: {
    chatRepo: ChatRepository;
    aiClient: AiClient;
    subject?: SubjectContext;
    /** sessionId:null(下書き)のとき、AI応答の受信成功後に一度だけ呼ばれてセッションを作る */
    createSession?: () => Promise<ChatSessionRecord>;
  },
  /** クイック質問の定型文かどうか。trueならチャット画面に表示しない(DBへ永続化する) */
  hideQuestion?: boolean,
): Promise<SendChatTurnResult> {
  // ユーザーが実際に入力したテキストには文脈付与の文字列を一切混ぜない。
  // 文脈は毎ターンsystem側で動的に組み立てる(docs/ai-client.md §2)。
  // 今回の質問はまだDBに無いため、保存済み履歴の末尾へメモリ上で連結してAIへ渡す。
  const history = sessionId === null ? [] : await deps.chatRepo.getMessages(sessionId);
  const messages: AiMessage[] = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: userText },
  ];

  const system = deps.subject
    ? `${CHAT_SYSTEM_PROMPT}\n\n---\n現在の話題:\n${buildSubjectContextBlock(deps.subject)}`
    : CHAT_SYSTEM_PROMPT;

  const result = await deps.aiClient.send({ system, messages });
  const reply = result.stopReason === 'refusal' && result.text.trim() === '' ? REFUSAL_MESSAGE : result.text;

  let sid = sessionId;
  if (sid === null) {
    if (!deps.createSession) throw new Error('sessionId:nullで呼ぶ場合はdeps.createSessionが必要です');
    sid = (await deps.createSession()).id;
  }
  await deps.chatRepo.appendMessage(sid, 'user', userText, { hidden: hideQuestion });
  await deps.chatRepo.appendMessage(sid, 'assistant', reply);
  await deps.chatRepo.touchSession(sid, Date.now());

  return { reply, sessionId: sid };
}
