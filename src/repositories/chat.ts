import type { ItIndexDB } from '../db';
import type { ChatMessageRecord, ChatSessionRecord } from '../types';

/**
 * 履歴画面「取り込み履歴」タブに残す会話の上限（2026-08-06追加）。
 * 取り込み済み・登録しなかった・取り込み待ちのいずれも合わせた件数で数える
 * （ユーザー確認済み）。超えた分は古い会話から削除する——**削除されるのは会話（chatMessages/
 * chatSessions）だけ**で、既に登録済みの単語・AI補足（terms/notes）は別テーブルのため影響しない。
 */
const MAX_CHAT_HISTORY = 30;

export interface ChatRepository {
  /** subjectLabel は termId:null（検索欄からの「AIで検索」）のときだけ渡す */
  createSession(termId: string | null, subjectLabel?: string): Promise<ChatSessionRecord>;
  appendMessage(sessionId: string, role: 'user' | 'assistant', content: string, options?: { hidden?: boolean }): Promise<void>;
  touchSession(sessionId: string, at: number): Promise<void>;
  /** ホーム画面の「取り込み待ち」一覧用。取り込み待ち（status:'open'）のセッション全件 */
  getOpenSessions(): Promise<ChatSessionRecord[]>;
  /** ある単語について取り込まずに残っているセッションがあれば返す。無ければundefined */
  findOpenSessionByTermId(termId: string): Promise<ChatSessionRecord | undefined>;
  /**
   * 同じ検索語で取り込まずに残っている「AIで検索」のセッションがあれば返す。
   * findOpenSessionByTermId と同じ考え方で、同じ語を続けて検索したときに
   * セッションが増殖して「取り込み待ち」一覧に同じ見出しが並ぶのを防ぐ。
   */
  findOpenSessionBySubjectLabel(label: string): Promise<ChatSessionRecord | undefined>;
  /** id指定での単体取得。リロード時の画面復元（#39）等、既知のsessionIdから状態を再構築する用途 */
  getSession(sessionId: string): Promise<ChatSessionRecord | undefined>;
  /**
   * 取り込み処理の開始を宣言する（'open'または'declined' → 'committing'）。**取れたら true**。
   * 既に 'committing'（別経路が処理中）や 'committed' なら false を返し、二重取り込みを防ぐ。
   * 「まとめて取り込む」と個別ボタンを続けて押した場合の競合もここで弾ける。
   * 'declined'（一度「登録しない」を選んだ会話）からも取れる——履歴タブの「取り込む」ボタンで
   * 気が変わって取り込み直せるようにするため。
   */
  beginCommit(sessionId: string): Promise<boolean>;
  /** 取り込みに失敗したときに 'committing' → 'open' へ戻す（再試行できる状態にする） */
  abortCommit(sessionId: string): Promise<void>;
  /** 冪等。既に committed なら何もしない */
  commitSession(sessionId: string): Promise<void>;
  /** 利用者が「登録しない」を選んだ（'open' → 'declined'）。会話は削除しない */
  declineSession(sessionId: string): Promise<void>;
  getMessages(sessionId: string): Promise<ChatMessageRecord[]>;
  /**
   * 履歴画面「取り込み履歴」タブ用。取り込み待ち・登録しなかった・取り込み済みを合わせて
   * 最近やり取りした順（lastActiveAt降順）に返す。処理中（'committing'）は対象外
   * （表示中に状態が変わる一瞬だけの状態のため、ここに出す意味が無い）。
   */
  getRecentSessions(limit: number): Promise<ChatSessionRecord[]>;
}

/** 上限を超えた古い会話を削除する。登録済みの単語・AI補足（terms/notes）には触れない */
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

    async findOpenSessionBySubjectLabel(label) {
      const openSessions = await db.chatSessions.where('status').equals('open').toArray();
      return openSessions.find((s) => s.termId === null && s.subjectLabel === label);
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
  };
}
