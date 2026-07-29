import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ItIndexDB } from '../db';
import { createAsksRepository } from '../repositories/asks';
import { createChatRepository } from '../repositories/chat';
import { createNotesRepository } from '../repositories/notes';
import { buildTermRecord, createTermsRepository, makeTermId } from '../repositories/terms';
import { applyDistribution, autoApplyAskedTerms, proposeDistribution } from './distribution';
import { createScriptedAiClient } from './testSupport';

function distributionJson(items: unknown[]): string {
  return JSON.stringify(items);
}

describe('proposeDistribution / applyDistribution', () => {
  let db: ItIndexDB;

  beforeEach(() => {
    db = new ItIndexDB(`test-distribution-${crypto.randomUUID()}`);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('proposes a new term as-is (no merge call, since there is no existing note)', async () => {
    const chatRepo = createChatRepository(db);
    const termsRepo = createTermsRepository(db);
    const notesRepo = createNotesRepository(db);
    const session = await chatRepo.createSession(null);
    await chatRepo.appendMessage(session.id, 'user', 'TCP/IPって何？');
    await chatRepo.appendMessage(session.id, 'assistant', '層に分けた通信規約です。');

    const claude = createScriptedAiClient([
      distributionJson([
        {
          term: 'TCP/IP',
          isTerm: true,
          askedByUser: true,
          summary: '通信の取り決めを層に分けた規約の集まり。',
          readings: ['ティーシーピーアイピー'],
          field: 'ネットワーク',
          draftBody: '層に分けた通信規約の集まり。',
          diagrams: [],
        },
      ]),
    ]);

    const proposal = await proposeDistribution(session.id, { chatRepo, termsRepo, notesRepo, claude });

    expect(proposal.proposedTerms).toHaveLength(1);
    expect(proposal.proposedTerms[0]).toMatchObject({
      term: 'TCP/IP',
      isNewTerm: true,
      askedByUser: true,
      summary: '通信の取り決めを層に分けた規約の集まり。',
      finalBody: '層に分けた通信規約の集まり。',
    });
    expect(claude.calls).toHaveLength(1); // マージ呼び出しは発生しない
  });

  it('excludes a new term the AI only mentioned in passing (askedByUser:false)', async () => {
    const chatRepo = createChatRepository(db);
    const termsRepo = createTermsRepository(db);
    const notesRepo = createNotesRepository(db);
    const session = await chatRepo.createSession(null);
    await chatRepo.appendMessage(session.id, 'user', 'TCP/IPって何？');
    await chatRepo.appendMessage(session.id, 'assistant', '層に分けた通信規約です。ルーティングという仕組みも関係します。');

    const claude = createScriptedAiClient([
      distributionJson([
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

    const proposal = await proposeDistribution(session.id, { chatRepo, termsRepo, notesRepo, claude });

    expect(proposal.proposedTerms).toHaveLength(1);
    expect(proposal.proposedTerms[0]).toMatchObject({ term: 'TCP/IP' });
  });

  it('keeps updating an already-known term even when askedByUser is false', async () => {
    const chatRepo = createChatRepository(db);
    const termsRepo = createTermsRepository(db);
    const notesRepo = createNotesRepository(db);
    const now = Date.now();

    const existing = buildTermRecord({
      term: 'ルーティング',
      readings: ['ルーティング'],
      summary: '経路制御。',
      field: 'ネットワーク',
      origin: 'seed',
      now,
    });
    await termsRepo.bulkPutFromSeed([existing]);

    const session = await chatRepo.createSession(null);
    await chatRepo.appendMessage(session.id, 'user', 'TCP/IPって何？');

    const claude = createScriptedAiClient([
      distributionJson([
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

    const proposal = await proposeDistribution(session.id, { chatRepo, termsRepo, notesRepo, claude });

    expect(proposal.proposedTerms).toHaveLength(1);
    expect(proposal.proposedTerms[0]).toMatchObject({ term: 'ルーティング', isNewTerm: false, askedByUser: false });
  });

  it('filters out isTerm:false items entirely', async () => {
    const chatRepo = createChatRepository(db);
    const termsRepo = createTermsRepository(db);
    const notesRepo = createNotesRepository(db);
    const session = await chatRepo.createSession(null);
    await chatRepo.appendMessage(session.id, 'user', '今日は天気がいいですね');

    const claude = createScriptedAiClient([distributionJson([{ term: '今日の天気', isTerm: false, diagrams: [] }])]);

    const proposal = await proposeDistribution(session.id, { chatRepo, termsRepo, notesRepo, claude });

    expect(proposal.proposedTerms).toEqual([]);
  });

  it('merges with an existing note when the term is already known', async () => {
    const chatRepo = createChatRepository(db);
    const termsRepo = createTermsRepository(db);
    const notesRepo = createNotesRepository(db);
    const now = Date.now();

    const existing = buildTermRecord({
      term: 'TCP/IP',
      readings: ['ティーシーピーアイピー'],
      summary: '規約の集まり。',
      field: 'ネットワーク',
      origin: 'seed',
      now,
    });
    await termsRepo.bulkPutFromSeed([existing]);
    await notesRepo.applyCommit(existing.id, '既存の説明。', [], 'device-A', now);

    const session = await chatRepo.createSession(existing.id);
    await chatRepo.appendMessage(session.id, 'user', 'TCP/IPについてもっと教えて');

    const claude = createScriptedAiClient([
      distributionJson([
        {
          term: 'TCP/IP',
          isTerm: true,
          askedByUser: true,
          summary: '規約の集まり。',
          readings: ['ティーシーピーアイピー'],
          field: 'ネットワーク',
          draftBody: '新しく聞いた説明。',
          diagrams: [],
        },
      ]),
      JSON.stringify({ body: '統合済みの説明。', diagrams: ['graph TD; A-->B'] }),
    ]);

    const proposal = await proposeDistribution(session.id, { chatRepo, termsRepo, notesRepo, claude });

    expect(claude.calls).toHaveLength(2); // 分配統合 + 統合(merge) の2回
    expect(proposal.proposedTerms[0]).toMatchObject({
      isNewTerm: false,
      finalBody: '統合済みの説明。',
      diagrams: ['graph TD; A-->B'],
    });
  });

  it('falls back to draftBody when the merge call returns unparsable output', async () => {
    const chatRepo = createChatRepository(db);
    const termsRepo = createTermsRepository(db);
    const notesRepo = createNotesRepository(db);
    const now = Date.now();

    const existing = buildTermRecord({
      term: 'TCP/IP',
      readings: ['ティーシーピーアイピー'],
      summary: '規約の集まり。',
      field: 'ネットワーク',
      origin: 'seed',
      now,
    });
    await termsRepo.bulkPutFromSeed([existing]);
    await notesRepo.applyCommit(existing.id, '既存の説明。', [], 'device-A', now);

    const session = await chatRepo.createSession(existing.id);
    await chatRepo.appendMessage(session.id, 'user', 'TCP/IPについてもっと教えて');

    const claude = createScriptedAiClient([
      distributionJson([
        {
          term: 'TCP/IP',
          isTerm: true,
          askedByUser: true,
          summary: '規約の集まり。',
          readings: ['ティーシーピーアイピー'],
          field: 'ネットワーク',
          draftBody: '新しい説明。',
          diagrams: [],
        },
      ]),
      'これはJSONではない壊れた応答',
    ]);

    const proposal = await proposeDistribution(session.id, { chatRepo, termsRepo, notesRepo, claude });

    expect(proposal.proposedTerms[0].finalBody).toBe('新しい説明。'); // draftBodyのまま
  });

  it('applyDistribution only writes approved terms, adds one ask per approved term, and commits the session', async () => {
    const chatRepo = createChatRepository(db);
    const termsRepo = createTermsRepository(db);
    const notesRepo = createNotesRepository(db);
    const asksRepo = createAsksRepository(db);
    const session = await chatRepo.createSession(null);

    const proposal = {
      sessionId: session.id,
      proposedTerms: [
        {
          term: 'TCP/IP',
          termId: makeTermId('TCP/IP'),
          isNewTerm: true,
          askedByUser: true,
          summary: '層に分けた通信規約の集まり。',
          readings: ['ティーシーピーアイピー'],
          field: 'ネットワーク' as const,
          finalBody: '説明A',
          diagrams: [],
        },
        {
          term: 'MTU',
          termId: makeTermId('MTU'),
          isNewTerm: true,
          askedByUser: true,
          summary: '一度に送れるデータの最大サイズ。',
          readings: ['エムティーユー'],
          field: 'ネットワーク' as const,
          finalBody: '説明B',
          diagrams: [],
        },
      ],
    };

    // TCP/IP だけ承認、MTU は却下
    await applyDistribution(proposal, new Set([makeTermId('TCP/IP')]), {
      termsRepo,
      notesRepo,
      asksRepo,
      chatRepo,
      deviceId: 'device-A',
    });

    const created = await termsRepo.getById(makeTermId('TCP/IP'));
    expect(created).toBeDefined();
    expect(created?.summary).toBe('層に分けた通信規約の集まり。'); // AI新規登録語もAI生成の初期説明を持つ（2026-07-29〜）
    expect(await termsRepo.getById(makeTermId('MTU'))).toBeUndefined();
    expect((await notesRepo.getByTermId(makeTermId('TCP/IP')))?.body).toBe('説明A');
    expect(await asksRepo.getByTermId(makeTermId('TCP/IP'))).toHaveLength(1);
    expect(await asksRepo.getByTermId(makeTermId('MTU'))).toHaveLength(0);

    const staleSessions = await chatRepo.findStaleOpenSessions(Date.now(), 0);
    expect(staleSessions.map((s) => s.id)).not.toContain(session.id); // committed済み
  });

  describe('autoApplyAskedTerms', () => {
    it('writes askedByUser:true items to the DB without an approval step, and leaves askedByUser:false items untouched', async () => {
      const chatRepo = createChatRepository(db);
      const termsRepo = createTermsRepository(db);
      const notesRepo = createNotesRepository(db);
      const asksRepo = createAsksRepository(db);
      const session = await chatRepo.createSession(null);

      const now = Date.now();
      const existingRouting = buildTermRecord({
        term: 'ルーティング',
        readings: ['ルーティング'],
        summary: '経路制御。',
        field: 'ネットワーク',
        origin: 'seed',
        now,
      });
      await termsRepo.bulkPutFromSeed([existingRouting]);

      const proposal = {
        sessionId: session.id,
        proposedTerms: [
          {
            term: 'TCP/IP',
            termId: makeTermId('TCP/IP'),
            isNewTerm: true,
            askedByUser: true,
            summary: '層に分けた通信規約の集まり。',
            readings: ['ティーシーピーアイピー'],
            field: 'ネットワーク' as const,
            finalBody: '説明A',
            diagrams: [],
          },
          {
            term: 'ルーティング',
            termId: makeTermId('ルーティング'),
            isNewTerm: false,
            askedByUser: false,
            summary: '経路を選ぶ仕組み。',
            readings: ['ルーティング'],
            field: 'ネットワーク' as const,
            finalBody: '統合済みの説明',
            diagrams: [],
          },
        ],
      };

      const { autoApplied, remaining } = await autoApplyAskedTerms(proposal, {
        termsRepo,
        notesRepo,
        asksRepo,
        deviceId: 'device-A',
      });

      expect(autoApplied.map((t) => t.term)).toEqual(['TCP/IP']);
      expect(remaining.map((t) => t.term)).toEqual(['ルーティング']);

      // askedByUser:true（TCP/IP）は書き込み済み
      expect(await termsRepo.getById(makeTermId('TCP/IP'))).toBeDefined();
      expect((await notesRepo.getByTermId(makeTermId('TCP/IP')))?.body).toBe('説明A');
      expect(await asksRepo.getByTermId(makeTermId('TCP/IP'))).toHaveLength(1);

      // askedByUser:false（ルーティング）はまだ書き込まれていない（承認画面待ち）
      expect((await notesRepo.getByTermId(makeTermId('ルーティング')))?.body).toBeUndefined();
      expect(await asksRepo.getByTermId(makeTermId('ルーティング'))).toHaveLength(0);
    });

    it('does not touch chatSessions.commitSession (caller decides when the session is fully resolved)', async () => {
      const chatRepo = createChatRepository(db);
      const termsRepo = createTermsRepository(db);
      const notesRepo = createNotesRepository(db);
      const asksRepo = createAsksRepository(db);
      const session = await chatRepo.createSession(null);

      const proposal = {
        sessionId: session.id,
        proposedTerms: [
          {
            term: 'TCP/IP',
            termId: makeTermId('TCP/IP'),
            isNewTerm: true,
            askedByUser: true,
            summary: '層に分けた通信規約の集まり。',
            readings: ['ティーシーピーアイピー'],
            field: 'ネットワーク' as const,
            finalBody: '説明A',
            diagrams: [],
          },
        ],
      };

      await autoApplyAskedTerms(proposal, { termsRepo, notesRepo, asksRepo, deviceId: 'device-A' });

      const stillOpen = await chatRepo.findStaleOpenSessions(Date.now(), 0);
      expect(stillOpen.map((s) => s.id)).toContain(session.id); // まだ committed になっていない
    });
  });
});
