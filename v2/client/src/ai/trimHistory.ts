import type { AiMessage } from './aiClient';

/**
 * AIへ送る会話履歴の上限(#181)。v1からの積み残し「チャット履歴の毎ターン全量送信」
 * (docs/v2/requirements.md §8)への対処で、**送信するぶんだけを絞る**。
 * DBへの保存と画面表示は従来どおり全件のまま(ai/chat.ts / screens/ChatScreen.tsx)。
 *
 * 上限はサーバー側にも別に存在する(v2/server/src/ai.ts の MAX_MESSAGES /
 * MAX_TOTAL_CONTENT_CHARS)。あちらは「境界の防御」で、超えたリクエストを400で弾く。
 * **実効の上限はこちら側**で、利用者が実際に受け取る挙動(古い会話が送られなくなる)を
 * 決めるのはこのファイル。
 */

/**
 * 送る直近メッセージ数の上限。6往復ぶん。
 * 用語1つを掘り下げる会話で、直前の文脈を保つのに十分な長さとして置いた値。
 */
export const MAX_SENT_MESSAGES = 12;

/**
 * 送る合計文字数の上限。
 * サーバー側の system 上限(10,000文字)と合わせても上流の実用域に収まる値として置いた。
 * 1件が極端に長い場合は件数上限だけでは抑えられないため、こちらも併せて見る。
 */
export const MAX_SENT_CHARS = 12_000;

export interface TrimChatHistoryResult {
  /** 実際にAIへ送る履歴(古い順)。**呼び出し側はこの後ろへ今回の質問を足す前提** */
  messages: AiMessage[];
  /** 送らずに落とした古いメッセージの件数。0なら全部送っている */
  omitted: number;
}

/**
 * 保存済みの履歴を末尾(新しい方)から詰めて、上限に収まる範囲だけを返す。
 *
 * **返した履歴の先頭は必ず `user` になる**(空の場合を除く)。サーバーは先頭が user でない
 * リクエストを400で弾く(`v2/server/src/ai.ts`「先頭のmessageはuserである必要があります」)ため、
 * 単純に末尾からN件取ると assistant 始まりになって送信自体が失敗しうる。
 * ここで先頭を揃えるのが、この関数を分けている主な理由。
 *
 * **空を返すことがある**(直近1件が上限を超える長さの assistant 応答だった場合など)。
 * 呼び出し側が今回の質問(user)を必ず後ろへ足すため、空でもリクエストは
 * 「userが1件」の正しい形になる——中途半端に assistant 始まりを残す方が確実に失敗する。
 *
 * 上限は件数と文字数のどちらか先に当たった方で効く。
 */
export function trimChatHistory(
  history: AiMessage[],
  options: { maxMessages?: number; maxChars?: number } = {},
): TrimChatHistoryResult {
  const maxMessages = options.maxMessages ?? MAX_SENT_MESSAGES;
  const maxChars = options.maxChars ?? MAX_SENT_CHARS;

  // 末尾から遡り、件数と文字数のどちらの上限にも収まる範囲の開始位置を決める
  let startIndex = history.length;
  let chars = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const count = history.length - i;
    const nextChars = chars + history[i].content.length;
    if (count > maxMessages || nextChars > maxChars) break;
    chars = nextChars;
    startIndex = i;
  }

  // 先頭がassistantなら落としてuser始まりに揃える(サーバーの先頭ロール検証に合わせる)。
  // 全部落ちて空になる場合もそのまま——上の説明のとおり、呼び出し側が足すuserで形は整う。
  while (startIndex < history.length && history[startIndex].role !== 'user') {
    startIndex++;
  }

  return { messages: history.slice(startIndex), omitted: startIndex };
}
