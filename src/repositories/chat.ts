import type { ItIndexDB } from '../db';
import type { ChatMessageRecord, ChatSessionRecord } from '../types';

export interface ChatRepository {
  createSession(termId: string | null): Promise<ChatSessionRecord>;
  appendMessage(sessionId: string, role: 'user' | 'assistant', content: string): Promise<void>;
  touchSession(sessionId: string, at: number): Promise<void>;
  /** ホーム画面の「AIによる単語更新待ち」一覧用。確定待ち（status:'open'）のセッション全件 */
  getOpenSessions(): Promise<ChatSessionRecord[]>;
  /** ある単語について未確定のまま残っているセッションがあれば返す。無ければundefined */
  findOpenSessionByTermId(termId: string): Promise<ChatSessionRecord | undefined>;
  /** 冪等。既に committed なら何もしない */
  commitSession(sessionId: string): Promise<void>;
  getMessages(sessionId: string): Promise<ChatMessageRecord[]>;
}

export function createChatRepository(db: ItIndexDB): ChatRepository {
  return {
    async createSession(termId) {
      const now = Date.now();
      const session: ChatSessionRecord = {
        id: crypto.randomUUID(),
        termId,
        startedAt: now,
        lastActiveAt: now,
        status: 'open',
      };
      await db.chatSessions.add(session);
      return session;
    },

    async appendMessage(sessionId, role, content) {
      // Date.now() はミリ秒精度なので、短時間に連続送信すると同一値になり得る。
      // sortBy('at') の順序が会話順と一致しなくなる（idはUUIDで時系列と無関係なため
      // タイブレークに使えない）ので、同一セッション内では単調増加を保証する。
      const existing = await db.chatMessages.where('sessionId').equals(sessionId).toArray();
      const maxAt = existing.reduce((max, m) => Math.max(max, m.at), 0);
      const at = Math.max(Date.now(), maxAt + 1);

      const message: ChatMessageRecord = {
        id: crypto.randomUUID(),
        sessionId,
        role,
        content,
        at,
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

    async commitSession(sessionId) {
      const session = await db.chatSessions.get(sessionId);
      if (!session || session.status === 'committed') return;
      await db.chatSessions.update(sessionId, { status: 'committed' });
    },

    async getMessages(sessionId) {
      return db.chatMessages.where('sessionId').equals(sessionId).sortBy('at');
    },
  };
}
