import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ItIndexDB } from '../db';
import { createAsksRepository, type AsksRepository } from '../repositories/asks';
import { createChatRepository, type ChatRepository } from '../repositories/chat';
import { createNotesRepository, type NotesRepository } from '../repositories/notes';
import { buildTermRecord, createTermsRepository, makeTermId, type TermsRepository } from '../repositories/terms';
import { createCommitOrchestrator, type CommitOrchestratorDeps } from './commitOrchestrator';
import { createScriptedAiClient } from './testSupport';

/** テストごとに必須依存（asksRepo/deviceId/autoUpdateExistingTerms）を毎回書かずに済むようにする */
function baseDeps(
  db: ItIndexDB,
  overrides: Partial<CommitOrchestratorDeps> & Pick<CommitOrchestratorDeps, 'chatRepo' | 'termsRepo' | 'notesRepo' | 'claude'>,
): CommitOrchestratorDeps {
  return {
    db,
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

  it('triggerCommit fires the commit immediately (確定ボタンのみが確定操作。2026-07-30改訂で自動トリガーは廃止)', async () => {
    const session = await chatRepo.createSession(null);
    await chatRepo.appendMessage(session.id, 'user', 'TCP/IPって何？');

    const claude = createScriptedAiClient(['[]']);
    const orchestrator = createCommitOrchestrator(baseDeps(db, { chatRepo, termsRepo, notesRepo, claude }));

    await orchestrator.triggerCommit(session.id);

    const open = await chatRepo.getOpenSessions();
    expect(open.map((s) => s.id)).not.toContain(session.id); // committed済み
  });

  it('skips the AI call and commits immediately for a session with no messages (empty-session bug)', async () => {
    const session = await chatRepo.createSession(null);

    const claude = { send: vi.fn() };
    const orchestrator = createCommitOrchestrator(baseDeps(db, { chatRepo, termsRepo, notesRepo, claude }));

    await orchestrator.triggerCommit(session.id);

    expect(claude.send).not.toHaveBeenCalled();

    const open = await chatRepo.getOpenSessions();
    expect(open.map((s) => s.id)).not.toContain(session.id); // committed済み
  });

  it('leaves the session open and calls onError when the AI call fails (committing --> open)', async () => {
    const session = await chatRepo.createSession(null);
    await chatRepo.appendMessage(session.id, 'user', 'TCP/IPって何？');

    const claude = { send: vi.fn().mockRejectedValue(new Error('network down')) };
    const onError = vi.fn();
    const orchestrator = createCommitOrchestrator(baseDeps(db, { chatRepo, termsRepo, notesRepo, claude, onError }));

    await orchestrator.triggerCommit(session.id);

    expect(onError).toHaveBeenCalledWith(session.id, expect.any(Error));

    const open = await chatRepo.getOpenSessions();
    expect(open.map((s) => s.id)).toContain(session.id); // committed になっていない
  });

  it('never loses chat messages when the AI call fails (data integrity)', async () => {
    const session = await chatRepo.createSession(null);
    await chatRepo.appendMessage(session.id, 'user', 'TCP/IPって何？');
    await chatRepo.appendMessage(session.id, 'assistant', '層に分けた通信規約の集まりです。');

    const claude = { send: vi.fn().mockRejectedValue(new Error('network down')) };
    const orchestrator = createCommitOrchestrator(baseDeps(db, { chatRepo, termsRepo, notesRepo, claude }));

    await orchestrator.triggerCommit(session.id);

    const messages = await chatRepo.getMessages(session.id);
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('TCP/IPって何？');
    expect(messages[1].content).toBe('層に分けた通信規約の集まりです。');
  });

  it('rolls back every write when a later term fails mid-commit, leaving no partial data (data integrity)', async () => {
    const session = await chatRepo.createSession(null);
    await chatRepo.appendMessage(session.id, 'user', '複数の語について聞いた');

    const claude = createScriptedAiClient([
      JSON.stringify([
        {
          term: '一つ目語',
          isTerm: true,
          askedByUser: true,
          summary: '説明1',
          readings: ['ヒトツメゴ'],
          field: 'ネットワーク',
          draftBody: '説明1',
          diagrams: [],
        },
        {
          term: '二つ目語',
          isTerm: true,
          askedByUser: true,
          summary: '説明2',
          readings: ['フタツメゴ'],
          field: 'ネットワーク',
          draftBody: '説明2',
          diagrams: [],
        },
      ]),
    ]);

    // 1語目は成功、2語目の書き込みで失敗するように細工する（DB書き込み自体の失敗を模す）
    let upsertCount = 0;
    const flakyTermsRepo: TermsRepository = {
      ...termsRepo,
      async upsertFromAi(term) {
        upsertCount++;
        if (upsertCount === 2) throw new Error('simulated write failure');
        return termsRepo.upsertFromAi(term);
      },
    };

    const onError = vi.fn();
    const orchestrator = createCommitOrchestrator(
      baseDeps(db, { chatRepo, termsRepo: flakyTermsRepo, notesRepo, claude, onError }),
    );

    await orchestrator.triggerCommit(session.id);

    expect(onError).toHaveBeenCalled();

    // 1語目もロールバックされ、部分的な書き込みが一切残っていない
    expect(await termsRepo.getById(makeTermId('一つ目語'))).toBeUndefined();
    expect(await termsRepo.getById(makeTermId('二つ目語'))).toBeUndefined();
    expect(await notesRepo.getByTermId(makeTermId('一つ目語'))).toBeUndefined();
    expect(await asksRepo.getByTermId(makeTermId('一つ目語'))).toHaveLength(0);

    // セッションは再試行できる状態（open）に戻っている
    const open = await chatRepo.getOpenSessions();
    expect(open.map((s) => s.id)).toContain(session.id);

    // チャット履歴自体は失敗しても一切失われない
    expect(await chatRepo.getMessages(session.id)).toHaveLength(1);
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

      const open = await chatRepo.getOpenSessions();
      expect(open.map((s) => s.id)).not.toContain(session.id); // committed済み
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
      const open = await chatRepo.getOpenSessions();
      expect(open.map((s) => s.id)).not.toContain(session.id);
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
    });
  });
});
