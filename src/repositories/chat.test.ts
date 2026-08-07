import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ItIndexDB } from '../db';
import { createChatRepository } from './chat';

describe('ChatRepository', () => {
  let db: ItIndexDB;

  beforeEach(() => {
    db = new ItIndexDB(`test-chat-${crypto.randomUUID()}`);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('commitSession is idempotent', async () => {
    const repo = createChatRepository(db);
    const session = await repo.createSession(null);

    await repo.commitSession(session.id);
    await repo.commitSession(session.id); // 2回目も例外を投げない

    const open = await repo.getOpenSessions();
    expect(open).toHaveLength(0);
  });

  it('getSession returns the session by id, or undefined if missing', async () => {
    const repo = createChatRepository(db);
    const session = await repo.createSession('cors');

    expect(await repo.getSession(session.id)).toMatchObject({ id: session.id, termId: 'cors' });
    expect(await repo.getSession('does-not-exist')).toBeUndefined();
  });

  // 回帰: 取り込み処理はAI呼び出しで数秒〜十数秒かかる。その間に同じ語のチャットを開くと
  // 同一セッションが再開されてしまい、あとから走り終えた取り込みがそれを committed にするため、
  // 追加した発言が黙って捨てられていた。取り込み中は再開・再取り込みの対象から外す。
  it('beginCommit takes the session out of the pending list and blocks a second commit', async () => {
    const repo = createChatRepository(db);
    const session = await repo.createSession('cors');

    expect(await repo.beginCommit(session.id)).toBe(true);
    expect(await repo.getOpenSessions()).toHaveLength(0);
    expect(await repo.findOpenSessionByTermId('cors')).toBeUndefined();
    // 2回目は取れない（「まとめて取り込む」と個別ボタンを続けて押した場合の二重実行を防ぐ）
    expect(await repo.beginCommit(session.id)).toBe(false);
  });

  it('abortCommit puts a failed commit back into the pending list', async () => {
    const repo = createChatRepository(db);
    const session = await repo.createSession('cors');

    await repo.beginCommit(session.id);
    await repo.abortCommit(session.id);

    expect(await repo.getOpenSessions()).toHaveLength(1);
    expect(await repo.beginCommit(session.id)).toBe(true); // 再試行できる
  });

  it('abortCommit does not resurrect an already committed session', async () => {
    const repo = createChatRepository(db);
    const session = await repo.createSession('cors');

    await repo.beginCommit(session.id);
    await repo.commitSession(session.id);
    await repo.abortCommit(session.id);

    expect(await repo.getOpenSessions()).toHaveLength(0);
  });

  // 検索欄からの「AIで検索」（termId:null + subjectLabel）。辞書に無い語も聞けるようにするため、
  // 語ではなく入力文字列を主題にする。取り込み待ち一覧に何のチャットか出すために label が要る。
  describe('AIで検索（termId:null のセッション）', () => {
    it('stores the typed string as subjectLabel', async () => {
      const repo = createChatRepository(db);
      const session = await repo.createSession(null, '量子もつれ');

      expect(await repo.getSession(session.id)).toMatchObject({ termId: null, subjectLabel: '量子もつれ' });
    });

    it('findOpenSessionBySubjectLabel reuses an open session for the same query', async () => {
      const repo = createChatRepository(db);
      const session = await repo.createSession(null, '量子もつれ');

      expect((await repo.findOpenSessionBySubjectLabel('量子もつれ'))?.id).toBe(session.id);
      expect(await repo.findOpenSessionBySubjectLabel('別の語')).toBeUndefined();
    });

    it('findOpenSessionBySubjectLabel ignores committed sessions and term-linked ones', async () => {
      const repo = createChatRepository(db);
      const committed = await repo.createSession(null, '量子もつれ');
      await repo.commitSession(committed.id);
      // 同じ文字列がたまたま見出し語のセッションにも使われている場合、そちらは拾わない
      await repo.createSession('量子もつれ');

      expect(await repo.findOpenSessionBySubjectLabel('量子もつれ')).toBeUndefined();
    });

    it('legacy free-mode sessions (no subjectLabel) are never matched', async () => {
      const repo = createChatRepository(db);
      await repo.createSession(null);

      expect(await repo.findOpenSessionBySubjectLabel('')).toBeUndefined();
    });
  });

  // 「登録しない」（2026-08-06追加）。AIの判定に任せず、利用者が明示的に拒否した場合の状態。
  // 会話は削除しない——履歴タブの「取り込む」ボタンで後から取り込み直せる。
  describe('declineSession（登録しない）', () => {
    it('moves an open session to declined and takes it out of the pending list', async () => {
      const repo = createChatRepository(db);
      const session = await repo.createSession('cors');

      await repo.declineSession(session.id);

      expect((await repo.getSession(session.id))?.status).toBe('declined');
      expect(await repo.getOpenSessions()).toHaveLength(0);
    });

    it('does not touch a session that is not open (e.g. already committing)', async () => {
      const repo = createChatRepository(db);
      const session = await repo.createSession('cors');
      await repo.beginCommit(session.id);

      await repo.declineSession(session.id);

      expect((await repo.getSession(session.id))?.status).toBe('committing');
    });

    it('a declined session can be committed later via beginCommit (気が変わって取り込み直す)', async () => {
      const repo = createChatRepository(db);
      const session = await repo.createSession('cors');
      await repo.declineSession(session.id);

      expect(await repo.beginCommit(session.id)).toBe(true);
      expect((await repo.getSession(session.id))?.status).toBe('committing');
    });
  });

  describe('getRecentSessions（履歴画面「取り込み履歴」タブ用）', () => {
    it('returns open, declined and committed sessions, newest lastActiveAt first', async () => {
      const repo = createChatRepository(db);
      const first = await repo.createSession('a');
      await repo.touchSession(first.id, 100);
      const second = await repo.createSession('b');
      await repo.touchSession(second.id, 300);
      const third = await repo.createSession('c');
      await repo.touchSession(third.id, 200);
      await repo.declineSession(second.id);
      await repo.commitSession(third.id);

      const recent = await repo.getRecentSessions(10);
      expect(recent.map((s) => s.id)).toEqual([second.id, third.id, first.id]);
    });

    it('excludes committing sessions', async () => {
      const repo = createChatRepository(db);
      const session = await repo.createSession('cors');
      await repo.beginCommit(session.id);

      expect(await repo.getRecentSessions(10)).toHaveLength(0);
    });

    it('respects the limit', async () => {
      const repo = createChatRepository(db);
      for (let i = 0; i < 5; i++) await repo.createSession(`term-${i}`);

      expect(await repo.getRecentSessions(3)).toHaveLength(3);
    });
  });

  describe('自動30件制限（登録済みの単語データは対象外）', () => {
    it('keeps only the 30 most recently active sessions, oldest evicted first', async () => {
      const repo = createChatRepository(db);
      const sessions = [];
      for (let i = 0; i < 32; i++) {
        const s = await repo.createSession(`term-${i}`);
        await repo.touchSession(s.id, i); // 作成順にlastActiveAtを単調増加させる
        sessions.push(s);
      }

      const all = await repo.getRecentSessions(100);
      expect(all).toHaveLength(30);
      // 最も古い2件（term-0, term-1）は削除されている
      expect(all.map((s) => s.termId)).not.toContain('term-0');
      expect(all.map((s) => s.termId)).not.toContain('term-1');
      expect(all.map((s) => s.termId)).toContain('term-31');
    });

    it('deletes messages of evicted sessions too, but never protects a committing one from staying below the cap check', async () => {
      const repo = createChatRepository(db);
      const evicted = await repo.createSession('old-term');
      await repo.appendMessage(evicted.id, 'user', '古い質問');
      await repo.touchSession(evicted.id, 0);

      for (let i = 0; i < 30; i++) {
        const s = await repo.createSession(`term-${i}`);
        await repo.touchSession(s.id, i + 1);
      }

      expect(await repo.getSession(evicted.id)).toBeUndefined();
      expect(await repo.getMessages(evicted.id)).toHaveLength(0);
    });
  });
});
