import type { ItIndexDB } from '../db';
import type { ChatMessageRecord, ChatSessionRecord } from '../types';

export interface ChatRepository {
  createSession(termId: string | null): Promise<ChatSessionRecord>;
  appendMessage(sessionId: string, role: 'user' | 'assistant', content: string, options?: { hidden?: boolean }): Promise<void>;
  touchSession(sessionId: string, at: number): Promise<void>;
  /** ホーム画面の「取り込み待ち」一覧用。取り込み待ち（status:'open'）のセッション全件 */
  getOpenSessions(): Promise<ChatSessionRecord[]>;
  /** ある単語について取り込まずに残っているセッションがあれば返す。無ければundefined */
  findOpenSessionByTermId(termId: string): Promise<ChatSessionRecord | undefined>;
  /** id指定での単体取得。リロード時の画面復元（#39）等、既知のsessionIdから状態を再構築する用途 */
  getSession(sessionId: string): Promise<ChatSessionRecord | undefined>;
  /**
   * 取り込み処理の開始を宣言する（'open' → 'committing'）。**取れたら true**。
   * 既に 'committing'（別経路が処理中）や 'committed' なら false を返し、二重取り込みを防ぐ。
   * 「まとめて取り込む」と個別ボタンを続けて押した場合の競合もここで弾ける。
   */
  beginCommit(sessionId: string): Promise<boolean>;
  /** 取り込みに失敗したときに 'committing' → 'open' へ戻す（再試行できる状態にする） */
  abortCommit(sessionId: string): Promise<void>;
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

    async appendMessage(sessionId, role, content, options) {
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

    async getSession(sessionId) {
      return db.chatSessions.get(sessionId);
    },

    async beginCommit(sessionId) {
      // 「読んでから書く」を1つのトランザクションに包む。包まないと、2箇所から同時に
      // 押された場合に両方が 'open' と判定して二重にAI呼び出しが走る
      // （settings.ts のバグ1と同じ形の競合）。
      return db.transaction('rw', db.chatSessions, async () => {
        const session = await db.chatSessions.get(sessionId);
        if (!session || session.status !== 'open') return false;
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

    async getMessages(sessionId) {
      return db.chatMessages.where('sessionId').equals(sessionId).sortBy('at');
    },
  };
}
