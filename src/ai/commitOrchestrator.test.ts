import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ItIndexDB } from '../db';
import { createChatRepository } from '../repositories/chat';
import { createNotesRepository } from '../repositories/notes';
import { createTermsRepository } from '../repositories/terms';
import { createCommitOrchestrator } from './commitOrchestrator';
import { createScriptedAiClient } from './testSupport';

// fake-indexeddb は内部で setTimeout を使ってイベントディスパッチをシミュレートしているため、
// vi.useFakeTimers() を使うとDB操作自体がハングする。実時間の短いタイムアウト値で代用する。
const TEST_TIMEOUT_MS = 50;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('createCommitOrchestrator', () => {
  let db: ItIndexDB;

  beforeEach(() => {
    db = new ItIndexDB(`test-orchestrator-${crypto.randomUUID()}`);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('fires a commit after the timeout elapses with no activity (trigger②)', async () => {
    const chatRepo = createChatRepository(db);
    const termsRepo = createTermsRepository(db);
    const notesRepo = createNotesRepository(db);
    const session = await chatRepo.createSession(null);
    await chatRepo.appendMessage(session.id, 'user', 'TCP/IPって何？');

    const claude = createScriptedAiClient(['[]']);
    const onProposalReady = vi.fn();
    const orchestrator = createCommitOrchestrator({
      chatRepo,
      termsRepo,
      notesRepo,
      claude,
      onProposalReady,
      timeoutMs: TEST_TIMEOUT_MS,
    });

    orchestrator.noteActivity(session.id);
    await wait(TEST_TIMEOUT_MS + 30);

    expect(onProposalReady).toHaveBeenCalledTimes(1);
    expect(onProposalReady.mock.calls[0][0].sessionId).toBe(session.id);
    orchestrator.dispose();
  });

  it('does not fire before the timeout has elapsed', async () => {
    const chatRepo = createChatRepository(db);
    const termsRepo = createTermsRepository(db);
    const notesRepo = createNotesRepository(db);
    const session = await chatRepo.createSession(null);
    await chatRepo.appendMessage(session.id, 'user', 'TCP/IPって何？');

    const claude = createScriptedAiClient(['[]']);
    const onProposalReady = vi.fn();
    const orchestrator = createCommitOrchestrator({
      chatRepo,
      termsRepo,
      notesRepo,
      claude,
      onProposalReady,
      timeoutMs: TEST_TIMEOUT_MS,
    });

    orchestrator.noteActivity(session.id);
    await wait(TEST_TIMEOUT_MS / 2);

    expect(onProposalReady).not.toHaveBeenCalled();
    orchestrator.dispose();
  });

  it('resets the timer on repeated activity instead of firing early', async () => {
    const chatRepo = createChatRepository(db);
    const termsRepo = createTermsRepository(db);
    const notesRepo = createNotesRepository(db);
    const session = await chatRepo.createSession(null);
    await chatRepo.appendMessage(session.id, 'user', 'TCP/IPって何？');

    const claude = createScriptedAiClient(['[]']);
    const onProposalReady = vi.fn();
    const orchestrator = createCommitOrchestrator({
      chatRepo,
      termsRepo,
      notesRepo,
      claude,
      onProposalReady,
      timeoutMs: TEST_TIMEOUT_MS,
    });

    orchestrator.noteActivity(session.id);
    await wait(TEST_TIMEOUT_MS * 0.7);
    orchestrator.noteActivity(session.id); // タイマーが引き直される

    await wait(TEST_TIMEOUT_MS * 0.7); // 最初の活動から見れば期限超過だが、直近の活動からはまだ
    expect(onProposalReady).not.toHaveBeenCalled();

    await wait(TEST_TIMEOUT_MS * 0.5); // 直近の活動から期限超過
    expect(onProposalReady).toHaveBeenCalledTimes(1);
    orchestrator.dispose();
  });

  it('triggerCommit fires immediately and cancels any pending timer (triggers①③)', async () => {
    const chatRepo = createChatRepository(db);
    const termsRepo = createTermsRepository(db);
    const notesRepo = createNotesRepository(db);
    const session = await chatRepo.createSession(null);
    await chatRepo.appendMessage(session.id, 'user', 'TCP/IPって何？');

    const claude = createScriptedAiClient(['[]']);
    const onProposalReady = vi.fn();
    const orchestrator = createCommitOrchestrator({
      chatRepo,
      termsRepo,
      notesRepo,
      claude,
      onProposalReady,
      timeoutMs: TEST_TIMEOUT_MS,
    });

    orchestrator.noteActivity(session.id);
    await orchestrator.triggerCommit(session.id);
    expect(onProposalReady).toHaveBeenCalledTimes(1);

    await wait(TEST_TIMEOUT_MS + 30); // 元のタイマーは既にキャンセルされているはず
    expect(onProposalReady).toHaveBeenCalledTimes(1);
    orchestrator.dispose();
  });

  it('recoverStaleSessions commits every session idle past the timeout (trigger④)', async () => {
    const chatRepo = createChatRepository(db);
    const termsRepo = createTermsRepository(db);
    const notesRepo = createNotesRepository(db);

    const staleSession = await chatRepo.createSession(null);
    await chatRepo.appendMessage(staleSession.id, 'user', 'TCP/IPって何？');
    await chatRepo.touchSession(staleSession.id, Date.now() - 20 * 60 * 1000);
    const freshSession = await chatRepo.createSession(null);
    await chatRepo.touchSession(freshSession.id, Date.now());

    const claude = createScriptedAiClient(['[]']);
    const onProposalReady = vi.fn();
    const orchestrator = createCommitOrchestrator({ chatRepo, termsRepo, notesRepo, claude, onProposalReady });

    await orchestrator.recoverStaleSessions();

    expect(onProposalReady).toHaveBeenCalledTimes(1);
    expect(onProposalReady.mock.calls[0][0].sessionId).toBe(staleSession.id);
    orchestrator.dispose();
  });

  it('recoverStaleSessions skips stale sessions with no messages instead of calling the AI (empty-session bug)', async () => {
    const chatRepo = createChatRepository(db);
    const termsRepo = createTermsRepository(db);
    const notesRepo = createNotesRepository(db);

    // 「AIに聞く」を押しただけで、一言も送らずに離脱したセッションを模す
    const abandonedSession = await chatRepo.createSession(null);
    await chatRepo.touchSession(abandonedSession.id, Date.now() - 20 * 60 * 1000);

    const claude = { send: vi.fn() };
    const onProposalReady = vi.fn();
    const orchestrator = createCommitOrchestrator({ chatRepo, termsRepo, notesRepo, claude, onProposalReady });

    await orchestrator.recoverStaleSessions();

    expect(claude.send).not.toHaveBeenCalled();
    expect(onProposalReady).not.toHaveBeenCalled();

    const stillOpen = await chatRepo.findStaleOpenSessions(Date.now(), 0);
    expect(stillOpen.map((s) => s.id)).not.toContain(abandonedSession.id); // committed 済みになっている
    orchestrator.dispose();
  });

  it('leaves the session open and calls onError when the AI call fails (committing --> open)', async () => {
    const chatRepo = createChatRepository(db);
    const termsRepo = createTermsRepository(db);
    const notesRepo = createNotesRepository(db);
    const session = await chatRepo.createSession(null);
    await chatRepo.appendMessage(session.id, 'user', 'TCP/IPって何？');

    const claude = { send: vi.fn().mockRejectedValue(new Error('network down')) };
    const onProposalReady = vi.fn();
    const onError = vi.fn();
    const orchestrator = createCommitOrchestrator({ chatRepo, termsRepo, notesRepo, claude, onProposalReady, onError });

    await orchestrator.triggerCommit(session.id);

    expect(onProposalReady).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(session.id, expect.any(Error));

    const stillOpen = await chatRepo.findStaleOpenSessions(Date.now(), 0);
    expect(stillOpen.map((s) => s.id)).toContain(session.id); // committed になっていない
    orchestrator.dispose();
  });

  it('dispose() cancels pending timers', async () => {
    const chatRepo = createChatRepository(db);
    const termsRepo = createTermsRepository(db);
    const notesRepo = createNotesRepository(db);
    const session = await chatRepo.createSession(null);

    const claude = createScriptedAiClient(['[]']);
    const onProposalReady = vi.fn();
    const orchestrator = createCommitOrchestrator({
      chatRepo,
      termsRepo,
      notesRepo,
      claude,
      onProposalReady,
      timeoutMs: TEST_TIMEOUT_MS,
    });

    orchestrator.noteActivity(session.id);
    orchestrator.dispose();
    await wait(TEST_TIMEOUT_MS + 30);

    expect(onProposalReady).not.toHaveBeenCalled();
  });
});
