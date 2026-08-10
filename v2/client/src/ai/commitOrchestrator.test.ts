import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTermRecord, makeTermId } from '@it-index/shared';
import { ItIndexDB } from '../db';
import { createAsksRepository, type AsksRepository } from '../repositories/asks';
import { createChatRepository, type ChatRepository } from '../repositories/chat';
import { createNotesRepository, type NotesRepository } from '../repositories/notes';
import { createTermsRepository, type TermsRepository } from '../repositories/terms';
import { createCommitOrchestrator, type CommitOrchestratorDeps } from './commitOrchestrator';
import { createScriptedAiClient } from './testSupport';

/** テストごとに必須依存(asksRepo/deviceId/autoUpdateExistingTerms)を毎回書かずに済むようにする */
function baseDeps(
  db: ItIndexDB,
  overrides: Partial<CommitOrchestratorDeps> & Pick<CommitOrchestratorDeps, 'chatRepo' | 'termsRepo' | 'notesRepo' | 'aiClient'>,
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

  it('triggerCommitは即座に確定処理を実行する', async () => {
    const session = await chatRepo.createSession(null);
    await chatRepo.appendMessage(session.id, 'user', 'TCP/IPって何？');

    const aiClient = createScriptedAiClient(['[]']);
    const orchestrator = createCommitOrchestrator(baseDeps(db, { chatRepo, termsRepo, notesRepo, aiClient }));

    await orchestrator.triggerCommit(session.id);

    const open = await chatRepo.getOpenSessions();
    expect(open.map((s) => s.id)).not.toContain(session.id); // committed済み
  });

  it('メッセージが1件も無いセッションはAI呼び出しをスキップして即座に確定する', async () => {
    const session = await chatRepo.createSession(null);

    const aiClient = { send: vi.fn() };
    const orchestrator = createCommitOrchestrator(baseDeps(db, { chatRepo, termsRepo, notesRepo, aiClient }));

    await orchestrator.triggerCommit(session.id);

    expect(aiClient.send).not.toHaveBeenCalled();

    const open = await chatRepo.getOpenSessions();
    expect(open.map((s) => s.id)).not.toContain(session.id);
  });

  it('AI呼び出しが失敗した場合はセッションをopenに戻しonErrorを呼ぶ(committing --> open)', async () => {
    const session = await chatRepo.createSession(null);
    await chatRepo.appendMessage(session.id, 'user', 'TCP/IPって何？');

    const aiClient = { send: vi.fn().mockRejectedValue(new Error('network down')) };
    const onError = vi.fn();
    const orchestrator = createCommitOrchestrator(baseDeps(db, { chatRepo, termsRepo, notesRepo, aiClient, onError }));

    await orchestrator.triggerCommit(session.id);

    expect(onError).toHaveBeenCalledWith(session.id, expect.any(Error));

    const open = await chatRepo.getOpenSessions();
    expect(open.map((s) => s.id)).toContain(session.id);
  });

  it('AI呼び出しが失敗してもチャット履歴は失われない(データの整合性)', async () => {
    const session = await chatRepo.createSession(null);
    await chatRepo.appendMessage(session.id, 'user', 'TCP/IPって何？');
    await chatRepo.appendMessage(session.id, 'assistant', '層に分けた通信規約の集まりです。');

    const aiClient = { send: vi.fn().mockRejectedValue(new Error('network down')) };
    const orchestrator = createCommitOrchestrator(baseDeps(db, { chatRepo, termsRepo, notesRepo, aiClient }));

    await orchestrator.triggerCommit(session.id);

    const messages = await chatRepo.getMessages(session.id);
    expect(messages).toHaveLength(2);
  });

  it('複数語の確定処理の途中で失敗した場合、部分的な書き込みが一切残らない(ロールバック)', async () => {
    const session = await chatRepo.createSession(null);
    await chatRepo.appendMessage(session.id, 'user', '複数の語について聞いた');

    const aiClient = createScriptedAiClient([
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
      baseDeps(db, { chatRepo, termsRepo: flakyTermsRepo, notesRepo, aiClient, onError }),
    );

    await orchestrator.triggerCommit(session.id);

    expect(onError).toHaveBeenCalled();
    expect(await termsRepo.getById(makeTermId('一つ目語'))).toBeUndefined();
    expect(await termsRepo.getById(makeTermId('二つ目語'))).toBeUndefined();
    expect(await notesRepo.getByTermId(makeTermId('一つ目語'))).toBeUndefined();
    expect(await asksRepo.getByTermId(makeTermId('一つ目語'))).toHaveLength(0);

    const open = await chatRepo.getOpenSessions();
    expect(open.map((s) => s.id)).toContain(session.id);
    expect(await chatRepo.getMessages(session.id)).toHaveLength(1);
  });

  describe('自動反映(承認画面は無く常に自動反映する)', () => {
    it('askedByUser:trueの語をDBに書き込みセッションを確定する', async () => {
      const session = await chatRepo.createSession(null);
      await chatRepo.appendMessage(session.id, 'user', 'TCP/IPって何？');

      const aiClient = createScriptedAiClient([
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
      const orchestrator = createCommitOrchestrator(baseDeps(db, { chatRepo, termsRepo, notesRepo, aiClient }));

      await orchestrator.triggerCommit(session.id);

      expect(await termsRepo.getById(makeTermId('TCP/IP'))).toBeDefined();
      expect((await notesRepo.getByTermId(makeTermId('TCP/IP')))?.body).toBe('層に分けた通信規約の集まり。');
      expect(await asksRepo.getByTermId(makeTermId('TCP/IP'))).toHaveLength(1);

      const open = await chatRepo.getOpenSessions();
      expect(open.map((s) => s.id)).not.toContain(session.id);
    });

    it('mode:askedOnly(既定)は既存語へのaskedByUser:false更新を書き込まない', async () => {
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

      const aiClient = createScriptedAiClient([
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
        baseDeps(db, { chatRepo, termsRepo, notesRepo, aiClient, autoUpdateExistingTerms: 'askedOnly' }),
      );

      await orchestrator.triggerCommit(session.id);

      expect((await notesRepo.getByTermId(makeTermId('ルーティング')))?.body).toBeUndefined();
      expect(await asksRepo.getByTermId(makeTermId('ルーティング'))).toHaveLength(0);

      const open = await chatRepo.getOpenSessions();
      expect(open.map((s) => s.id)).not.toContain(session.id);
    });

    it('mode:allは既存語へのaskedByUser:false更新も書き込む', async () => {
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

      const aiClient = createScriptedAiClient([
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
        baseDeps(db, { chatRepo, termsRepo, notesRepo, aiClient, autoUpdateExistingTerms: 'all' }),
      );

      await orchestrator.triggerCommit(session.id);

      expect((await notesRepo.getByTermId(makeTermId('ルーティング')))?.body).toBe('経路を選ぶ仕組み。');
    });

    it('askedByUser:falseの語はmodeに関わらず新規登録しない', async () => {
      const session = await chatRepo.createSession(null);
      await chatRepo.appendMessage(session.id, 'user', 'TCP/IPって何？');

      const aiClient = createScriptedAiClient([
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
        baseDeps(db, { chatRepo, termsRepo, notesRepo, aiClient, autoUpdateExistingTerms: 'all' }),
      );

      await orchestrator.triggerCommit(session.id);

      expect(await termsRepo.getById(makeTermId('MTU'))).toBeUndefined();
    });
  });
});
