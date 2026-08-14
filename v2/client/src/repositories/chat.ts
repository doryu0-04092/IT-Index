import type { ItIndexDB } from '../db';
import type { ChatMessageRecord, ChatSessionRecord } from '../types';

/**
 * 履歴に残す会話の上限(v1 ../../src/repositories/chat.ts参照)。取り込み待ち・登録しなかった・
 * 取り込み済みのいずれも合わせた件数で数える。超えた分は最後にやり取りした日時が古いものから
 * 削除するが、削除されるのは会話(chatSessions/chatMessages)だけ——既に単語帳へ書き込み済みの
 * terms/notes/asksは別テーブルのため対象外。
 */
const MAX_CHAT_HISTORY = 30;

export interface ChatRepository {
  /** subjectLabelはtermId:null(検索欄からの「AIで検索」)のときだけ渡す */
  createSession(termId: string | null, subjectLabel?: string): Promise<ChatSessionRecord>;
  appendMessage(
    sessionId: string,
    role: 'user' | 'assistant',
    content: string,
    options?: { hidden?: boolean },
  ): Promise<void>;
  touchSession(sessionId: string, at: number): Promise<void>;
  /** 検索画面の「取り込み待ち」一覧用。取り込み待ち(status:'open')のセッション全件 */
  getOpenSessions(): Promise<ChatSessionRecord[]>;
  /** ある単語について取り込まずに残っているセッションがあれば返す。無ければundefined */
  findOpenSessionByTermId(termId: string): Promise<ChatSessionRecord | undefined>;
  /** 同じ検索語で取り込まずに残っている「AIで検索」のセッションがあれば返す */
  findOpenSessionBySubjectLabel(label: string): Promise<ChatSessionRecord | undefined>;
  getSession(sessionId: string): Promise<ChatSessionRecord | undefined>;
  /**
   * 取り込み処理の開始を宣言する('open'または'declined' → 'committing')。取れたらtrue。
   * 既に'committing'(別経路が処理中)や'committed'ならfalseを返し、二重取り込みを防ぐ。
   */
  beginCommit(sessionId: string): Promise<boolean>;
  /** 取り込みに失敗したときに'committing' → 'open'へ戻す(再試行できる状態にする) */
  abortCommit(sessionId: string): Promise<void>;
  /** 冪等。既にcommittedなら何もしない */
  commitSession(sessionId: string): Promise<void>;
  /** 利用者が「登録しない」を選んだ('open' → 'declined')。会話は削除しない */
  declineSession(sessionId: string): Promise<void>;
  getMessages(sessionId: string): Promise<ChatMessageRecord[]>;
  /** 取り込み待ち・登録しなかった・取り込み済みを合わせて最近やり取りした順に返す。処理中は対象外 */
  getRecentSessions(limit: number): Promise<ChatSessionRecord[]>;
  /**
   * アプリ起動時に一度だけ実行するクリーンアップ(本人指定)。open(取り込み待ち)かつ
   * メッセージ0件のセッションだけを削除する。セッション生成を最初の送信成立時まで遅らせる
   * ようにした(App.tsx openChatForTerm/openChatForQuery)後も、それ以前のバージョンで
   * 作られた不可視の空セッション(画面を開いただけで一度も送信せず戻った際に残っていたもの)の
   * 残骸が既存端末には残っている可能性があるため、その一括掃除に使う。
   * 安全性: status==='open'かつメッセージ数0件のときだけ削除する——1件でもメッセージが
   * あれば(送信を試みた実績がある、あるいは取り込み待ちとして意味を持つため)残す。
   * committing/committed/declinedは対象外(取り込み中・済み・登録しない選択済みのいずれも
   * 消してはいけない)。
   */
  deleteEmptyOpenSessions(): Promise<void>;
}

async function pruneOldSessions(db: ItIndexDB): Promise<void> {
  await db.transaction('rw', db.chatSessions, db.chatMessages, async () => {
    const all = await db.chatSessions.toArray();
    const candidates = all.filter((s) => s.status !== 'committing').sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    const excess = candidates.slice(MAX_CHAT_HISTORY);
    for (const s of excess) {
      await db.chatMessages.where('sessionId').equals(s.id).delete();
      await db.chatSessions.delete(s.id);
    }
  });
}

export function createChatRepository(db: ItIndexDB): ChatRepository {
  return {
    async createSession(termId, subjectLabel) {
      const now = Date.now();
      const session: ChatSessionRecord = {
        id: crypto.randomUUID(),
        termId,
        ...(subjectLabel === undefined ? {} : { subjectLabel }),
        startedAt: now,
        lastActiveAt: now,
        status: 'open',
      };
      await db.chatSessions.add(session);
      await pruneOldSessions(db);
      return session;
    },

    async appendMessage(sessionId, role, content, options) {
      // Date.now()はミリ秒精度なので、短時間に連続送信すると同一値になり得る。sortBy('at')の
      // 順序が会話順と一致しなくなるため、同一セッション内では単調増加を保証する(v1と同じ対応)。
      const existing = await db.chatMessages.where('sessionId').equals(sessionId).toArray();
      const maxAt = existing.reduce((max, m) => Math.max(max, m.at), 0);
      const at = Math.max(Date.now(), maxAt + 1);

      const message: ChatMessageRecord = {
        id: crypto.randomUUID(),
        sessionId,
        role,
        content,
        at,
        hidden: options?.hidden ?? false,
      };
      await db.chatMessages.add(message);
    },

    async touchSession(sessionId, at) {
      await db.chatSessions.update(sessionId, { lastActiveAt: at });
    },

    async getOpenSessions() {
      return db.chatSessions.where('status').equals('open').toArray();
    },

    async findOpenSessionByTermId(termId) {
      const openSessions = await db.chatSessions.where('status').equals('open').toArray();
      return openSessions.find((s) => s.termId === termId);
    },

    async findOpenSessionBySubjectLabel(label) {
      const openSessions = await db.chatSessions.where('status').equals('open').toArray();
      return openSessions.find((s) => s.termId === null && s.subjectLabel === label);
    },

    async getSession(sessionId) {
      return db.chatSessions.get(sessionId);
    },

    async beginCommit(sessionId) {
      // 「読んでから書く」を1つのトランザクションに包む。包まないと、2箇所から同時に
      // 押された場合に両方が'open'と判定して二重にAI呼び出しが走る。
      return db.transaction('rw', db.chatSessions, async () => {
        const session = await db.chatSessions.get(sessionId);
        if (!session || (session.status !== 'open' && session.status !== 'declined')) return false;
        await db.chatSessions.update(sessionId, { status: 'committing' });
        return true;
      });
    },

    async abortCommit(sessionId) {
      const session = await db.chatSessions.get(sessionId);
      if (!session || session.status !== 'committing') return;
      await db.chatSessions.update(sessionId, { status: 'open' });
    },

    async commitSession(sessionId) {
      const session = await db.chatSessions.get(sessionId);
      if (!session || session.status === 'committed') return;
      await db.chatSessions.update(sessionId, { status: 'committed' });
    },

    async declineSession(sessionId) {
      const session = await db.chatSessions.get(sessionId);
      if (!session || session.status !== 'open') return;
      await db.chatSessions.update(sessionId, { status: 'declined' });
    },

    async getMessages(sessionId) {
      return db.chatMessages.where('sessionId').equals(sessionId).sortBy('at');
    },

    async getRecentSessions(limit) {
      const all = await db.chatSessions.toArray();
      return all
        .filter((s) => s.status !== 'committing')
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
        .slice(0, limit);
    },

    async deleteEmptyOpenSessions() {
      await db.transaction('rw', db.chatSessions, db.chatMessages, async () => {
        const openSessions = await db.chatSessions.where('status').equals('open').toArray();
        for (const s of openSessions) {
          const messageCount = await db.chatMessages.where('sessionId').equals(s.id).count();
          if (messageCount === 0) await db.chatSessions.delete(s.id);
        }
      });
    },
  };
}
