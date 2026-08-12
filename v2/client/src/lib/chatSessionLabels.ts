import type { ChatRepository } from '../repositories/chat';
import type { TermsRepository } from '../repositories/terms';
import type { ChatSessionRecord } from '../types';

export interface SessionLabelRow {
  session: ChatSessionRecord;
  /** termIdひも付きなら辞書側の正式名(term.term)、無ければsubjectLabel */
  label: string;
}

/**
 * セッション一覧から表示用の行を組み立てる(v1 ../../../src/ui/pc/SearchScreen.tsx:86-104・
 * HistoryScreen.tsx:124-134を移植・共通化。検索画面の「取り込み待ち」一覧と履歴画面の
 * 「取り込み履歴」タブの両方が同じ組み立てを必要とするため切り出した)。
 *
 * - まだ何もやり取りしていない(messages.length===0)セッションは除外する。チャットを開いて
 *   すぐ戻っただけの項目が一覧に並ぶ問題への直接対応(v1コメント「まだ何もやり取りしていない
 *   セッションは表示不要」)。
 * - termIdがあれば辞書側の正式名、無ければsubjectLabelを見出しにする。どちらも無い
 *   (termIdが指す語が削除された、または廃止済みの旧「自由モード」)場合は主題を復元できず
 *   取り込む対象も決められないため一覧から外す。
 */
export async function loadSessionLabelRows(
  chatRepo: ChatRepository,
  termsRepo: TermsRepository,
  sessions: ChatSessionRecord[],
): Promise<SessionLabelRow[]> {
  const rows: SessionLabelRow[] = [];
  for (const session of sessions) {
    const messages = await chatRepo.getMessages(session.id);
    if (messages.length === 0) continue;

    if (session.termId) {
      const term = await termsRepo.getById(session.termId);
      if (term) rows.push({ session, label: term.term });
    } else if (session.subjectLabel) {
      rows.push({ session, label: session.subjectLabel });
    }
  }
  return rows;
}
