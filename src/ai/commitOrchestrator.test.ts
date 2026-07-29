import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ItIndexDB } from '../db';
import { createAsksRepository, type AsksRepository } from '../repositories/asks';
import { createChatRepository, type ChatRepository } from '../repositories/chat';
import { createNotesRepository, type NotesRepository } from '../repositories/notes';
import { buildTermRecord, createTermsRepository, makeTermId, type TermsRepository } from '../repositories/terms';
import { createCommitOrchestrator, type CommitOrchestratorDeps } from './commitOrchestrator';
import { createScriptedAiClient } from './testSupport';

// fake-indexeddb は内部で setTimeout を使ってイベントディスパッチをシミュレートしているため、
// vi.useFakeTimers() を使うとDB操作自体がハングする。実時間の短いタイムアウト値で代用する。
const TEST_TIMEOUT_MS = 50;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** テストごとに必須依存（asksRepo/deviceId/autoUpdateExistingTerms）を毎回書かずに済むようにする */
function baseDeps(
  db: ItIndexDB,
  overrides: Partial<CommitOrchestratorDeps> & Pick<CommitOrchestratorDeps, 'chatRepo' | 'termsRepo' | 'notesRepo' | 'claude'>,
): CommitOrchestratorDeps {
  return {
    asksRepo: createAsksRepository(db),
    deviceId: 'device-A',
    autoUpdateExistingTerms: 'askedOnly',
    ...overrides,
  };
}

describe('createCommitOrchestrator', () => {
  let db: ItIndexDB;
  let chatRepo: ChatRepository;
  let termsRepo: TermsRepository;
  let notesRepo: NotesRepository;
  let asksRepo: AsksRepository;

  beforeEach(() => {
    db = new ItIndexDB(`test-orchestrator-${crypto.randomUUID()}`);
    chatRepo = createChatRepository(db);
    termsRepo = createTermsRepository(db);
    notesRepo = createNotesRepository(db);
    asksRepo = createAsksRepository(db);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('fires a commit after the timeout elapses with no activity (trigger②)', async () => {
    const session = await chatRepo.createSession(null);
    await chatRepo.appendMessage(session.id, 'user', 'TCP/IPって何？');

    const claude = createScriptedAiClient(['[]']);
    const orchestrator = createCommitOrchestrator(
      baseDeps(db, { chatRepo, termsRepo, notesRepo, claude, timeoutMs: TEST_TIMEOUT_MS }),
    );

    orchestrator.noteActivity(session.id);
    await wait(TEST_TIMEOUT_MS + 30);

    const stillOpen = await chatRepo.findStaleOpenSessions(Date.now(), 0);
    expect(stillOpen.map((s) => s.id)).not.toContain(session.id); // committed済み
    orchestrator.dispose();
  });

  it('does not fire before the timeout has elapsed', async () => {
    const session = await chatRepo.createSession(null);
    await chatRepo.appendMessage(session.id, 'user', 'TCP/IPって何？');

    const claude = createScriptedAiClient(['[]']);
    const orchestrator = createCommitOrchestrator(
      baseDeps(db, { chatRepo, termsRepo, notesRepo, claude, timeoutMs: TEST_TIMEOUT_MS }),
    );

    orchestrator.noteActivity(session.id);
    await wait(TEST_TIMEOUT_MS / 2);

    const stillOpen = await chatRepo.findStaleOpenSessions(Date.now(), 0);
    expect(stillOpen.map((s) => s.id)).toContain(session.id); // まだ確定していない
    orchestrator.dispose();
  });

  it('resets the timer on repeated activity instead of firing early', async () => {
    const session = await chatRepo.createSession(null);
    await chatRepo.appendMessage(session.id, 'user', 'TCP/IPって何？');

    const claude = createScriptedAiClient(['[]']);
    const orchestrator = createCommitOrchestrator(
      baseDeps(db, { chatRepo, termsRepo, notesRepo, claude, timeoutMs: TEST_TIMEOUT_MS }),
    );

    orchestrator.noteActivity(session.id);
    await wait(TEST_TIMEOUT_MS * 0.7);
    orchestrator.noteActivity(session.id); // タイマーが引き直される

    await wait(TEST_TIMEOUT_MS * 0.7); // 最初の活動から見れば期限超過だが、直近の活動からはまだ
    expect((await chatRepo.findStaleOpenSessions(Date.now(), 0)).map((s) => s.id)).toContain(session.id);

    await wait(TEST_TIMEOUT_MS * 0.5); // 直近の活動から期限超過
    expect((await chatRepo.findStaleOpenSessions(Date.now(), 0)).map((s) => s.id)).not.toContain(session.id);
    orchestrator.dispose();
  });

  it('triggerCommit fires immediately and cancels any pending timer (triggers①③)', async () => {
    const session = await chatRepo.createSession(null);
    await chatRepo.appendMessage(session.id, 'user', 'TCP/IPって何？');

    const claude = createScriptedAiClient(['[]']);
    const orchestrator = createCommitOrchestrator(
      baseDeps(db, { chatRepo, termsRepo, notesRepo, claude, timeoutMs: TEST_TIMEOUT_MS }),
    );

    orchestrator.noteActivity(session.id);
    await orchestrator.triggerCommit(session.id);
    expect((await chatRepo.findStaleOpenSessions(Date.now(), 0)).map((s) => s.id)).not.toContain(session.id);

    await wait(TEST_TIMEOUT_MS + 30); // 元のタイマーは既にキャンセルされているはず（キャンセルされていなければ二重確定でエラーになり得る）
    orchestrator.dispose();
  });

  it('recoverStaleSessions commits every session idle past the timeout (trigger④)', async () => {
    const staleSession = await chatRepo.createSession(null);
    await chatRepo.appendMessage(staleSession.id, 'user', 'TCP/IPって何？');
    await chatRepo.touchSession(staleSession.id, Date.now() - 20 * 60 * 1000);
    const freshSession = await chatRepo.createSession(null);
    await chatRepo.touchSession(freshSession.id, Date.now());

    const claude = createScriptedAiClient(['[]']);
    const orchestrator = createCommitOrchestrator(baseDeps(db, { chatRepo, termsRepo, notesRepo, claude }));

    await orchestrator.recoverStaleSessions();

    const stillOpen = (await chatRepo.findStaleOpenSessions(Date.now(), 0)).map((s) => s.id);
    expect(stillOpen).not.toContain(staleSession.id); // committed済み
    expect(stillOpen).toContain(freshSession.id); // まだ新しいので対象外
    orchestrator.dispose();
  });

  it('recoverStaleSessions skips stale sessions with no messages instead of calling the AI (empty-session bug)', async () => {
    // 「AIに聞く」を押しただけで、一言も送らずに離脱したセッションを模す
    const abandonedSession = await chatRepo.createSession(null);
    await chatRepo.touchSession(abandonedSession.id, Date.now() - 20 * 60 * 1000);

    const claude = { send: vi.fn() };
    const orchestrator = createCommitOrchestrator(baseDeps(db, { chatRepo, termsRepo, notesRepo, claude }));

    await orchestrator.recoverStaleSessions();

    expect(claude.send).not.toHaveBeenCalled();

    const stillOpen = await chatRepo.findStaleOpenSessions(Date.now(), 0);
    expect(stillOpen.map((s) => s.id)).not.toContain(abandonedSession.id); // committed 済みになっている
    orchestrator.dispose();
  });

  it('leaves the session open and calls onError when the AI call fails (committing --> open)', async () => {
    const session = await chatRepo.createSession(null);
    await chatRepo.appendMessage(session.id, 'user', 'TCP/IPって何？');

    const claude = { send: vi.fn().mockRejectedValue(new Error('network down')) };
    const onError = vi.fn();
    const orchestrator = createCommitOrchestrator(baseDeps(db, { chatRepo, termsRepo, notesRepo, claude, onError }));

    await orchestrator.triggerCommit(session.id);

    expect(onError).toHaveBeenCalledWith(session.id, expect.any(Error));

    const stillOpen = await chatRepo.findStaleOpenSessions(Date.now(), 0);
    expect(stillOpen.map((s) => s.id)).toContain(session.id); // committed になっていない
    orchestrator.dispose();
  });

  describe('自動反映（2026-07-30: 承認画面を廃止し常に自動反映する）', () => {
    it('writes askedByUser:true terms to the DB and commits the session', async () => {
      const session = await chatRepo.createSession(null);
      await chatRepo.appendMessage(session.id, 'user', 'TCP/IPって何？');

      const claude = createScriptedAiClient([
        JSON.stringify([
          {
            term: 'TCP/IP',
            isTerm: true,
            askedByUser: true,
            summary: '層に分けた通信規約の集まり。',
            readings: ['ティーシーピーアイピー'],
            field: 'ネットワーク',
            draftBody: '層に分けた通信規約の集まり。',
            diagrams: [],
          },
        ]),
      ]);
      const orchestrator = createCommitOrchestrator(baseDeps(db, { chatRepo, termsRepo, notesRepo, claude }));

      await orchestrator.triggerCommit(session.id);

      expect(await termsRepo.getById(makeTermId('TCP/IP'))).toBeDefined();
      expect((await notesRepo.getByTermId(makeTermId('TCP/IP')))?.body).toBe('層に分けた通信規約の集まり。');

      const stillOpen = await chatRepo.findStaleOpenSessions(Date.now(), 0);
      expect(stillOpen.map((s) => s.id)).not.toContain(session.id); // committed済み
      orchestrator.dispose();
    });

    it('mode:askedOnly (既定) does not write askedByUser:false updates to an existing term', async () => {
      const session = await chatRepo.createSession(null);
      await chatRepo.appendMessage(session.id, 'user', 'TCP/IPって何？');

      await termsRepo.bulkPutFromSeed([
        buildTermRecord({
          term: 'ルーティング',
          readings: ['ルーティング'],
          summary: '経路制御。',
          field: 'ネットワーク',
          origin: 'seed',
          now: Date.now(),
        }),
      ]);

      const claude = createScriptedAiClient([
        JSON.stringify([
          {
            term: 'ルーティング',
            isTerm: true,
            askedByUser: false,
            summary: '経路を選ぶ仕組み。',
            readings: ['ルーティング'],
            field: 'ネットワーク',
            draftBody: '経路を選ぶ仕組み。',
            diagrams: [],
          },
        ]),
      ]);
      const orchestrator = createCommitOrchestrator(
        baseDeps(db, { chatRepo, termsRepo, notesRepo, claude, autoUpdateExistingTerms: 'askedOnly' }),
      );

      await orchestrator.triggerCommit(session.id);

      expect((await notesRepo.getByTermId(makeTermId('ルーティング')))?.body).toBeUndefined();
      expect(await asksRepo.getByTermId(makeTermId('ルーティング'))).toHaveLength(0);

      // 反映対象が無くても、セッション自体はちゃんと確定する
      const stillOpen = await chatRepo.findStaleOpenSessions(Date.now(), 0);
      expect(stillOpen.map((s) => s.id)).not.toContain(session.id);
      orchestrator.dispose();
    });

    it('mode:all writes askedByUser:false updates to an existing term too', async () => {
      const session = await chatRepo.createSession(null);
      await chatRepo.appendMessage(session.id, 'user', 'TCP/IPって何？');

      await termsRepo.bulkPutFromSeed([
        buildTermRecord({
          term: 'ルーティング',
          readings: ['ルーティング'],
          summary: '経路制御。',
          field: 'ネットワーク',
          origin: 'seed',
          now: Date.now(),
        }),
      ]);

      const claude = createScriptedAiClient([
        JSON.stringify([
          {
            term: 'ルーティング',
            isTerm: true,
            askedByUser: false,
            summary: '経路を選ぶ仕組み。',
            readings: ['ルーティング'],
            field: 'ネットワーク',
            draftBody: '経路を選ぶ仕組み。',
            diagrams: [],
          },
        ]),
      ]);
      const orchestrator = createCommitOrchestrator(
        baseDeps(db, { chatRepo, termsRepo, notesRepo, claude, autoUpdateExistingTerms: 'all' }),
      );

      await orchestrator.triggerCommit(session.id);

      expect((await notesRepo.getByTermId(makeTermId('ルーティング')))?.body).toBe('経路を選ぶ仕組み。');
      orchestrator.dispose();
    });

    it('never proposes a new term when askedByUser:false, regardless of mode', async () => {
      const session = await chatRepo.createSession(null);
      await chatRepo.appendMessage(session.id, 'user', 'TCP/IPって何？');

      const claude = createScriptedAiClient([
        JSON.stringify([
          {
            term: 'MTU',
            isTerm: true,
            askedByUser: false,
            summary: '一度に送れるデータの最大サイズ。',
            readings: ['エムティーユー'],
            field: 'ネットワーク',
            draftBody: '一度に送れるデータの最大サイズ。',
            diagrams: [],
          },
        ]),
      ]);
      const orchestrator = createCommitOrchestrator(
        baseDeps(db, { chatRepo, termsRepo, notesRepo, claude, autoUpdateExistingTerms: 'all' }),
      );

      await orchestrator.triggerCommit(session.id);

      expect(await termsRepo.getById(makeTermId('MTU'))).toBeUndefined();
      orchestrator.dispose();
    });
  });

  it('dispose() cancels pending timers', async () => {
    const session = await chatRepo.createSession(null);

    const claude = createScriptedAiClient(['[]']);
    const orchestrator = createCommitOrchestrator(
      baseDeps(db, { chatRepo, termsRepo, notesRepo, claude, timeoutMs: TEST_TIMEOUT_MS }),
    );

    orchestrator.noteActivity(session.id);
    orchestrator.dispose();
    await wait(TEST_TIMEOUT_MS + 30);

    const stillOpen = await chatRepo.findStaleOpenSessions(Date.now(), 0);
    expect(stillOpen.map((s) => s.id)).toContain(session.id); // disposeされたので確定していない
  });
});
