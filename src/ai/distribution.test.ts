import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ItIndexDB } from '../db';
import { createAsksRepository } from '../repositories/asks';
import { createChatRepository } from '../repositories/chat';
import { createNotesRepository } from '../repositories/notes';
import { buildTermRecord, createTermsRepository, makeTermId } from '../repositories/terms';
import { commitProposal, proposeDistribution } from './distribution';
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

  // 2026-08-06追加: 主題（利用者が明示的に選んだ語）は、AIのaskedByUser判定に関わらず
  // 必ず登録候補に残す。以前はAIの推測（askedByUser）だけに頼っていたため、AIが
  // 「利用者は尋ねていない」と誤判定すると主題の語が一件も書き込まれず、会話だけが
  // 確定扱いになって実質的に失われていた（ユーザー報告の不具合）。
  describe('主題の強制登録', () => {
    it('forces askedByUser:true for the subject term even when the AI says false (term mode)', async () => {
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

      // 単語詳細画面から「この語についてAIに聞く」で始めたセッション = 主題はTCP/IP
      const session = await chatRepo.createSession(existing.id);
      await chatRepo.appendMessage(session.id, 'user', 'TCP/IPって何？');

      const claude = createScriptedAiClient([
        distributionJson([
          {
            term: 'TCP/IP',
            isTerm: true,
            askedByUser: false, // AIが誤って「尋ねられていない」と判定したケースを模す
            summary: '規約の集まり。',
            readings: ['ティーシーピーアイピー'],
            field: 'ネットワーク',
            draftBody: '新しい説明。',
            diagrams: [],
          },
        ]),
      ]);

      const proposal = await proposeDistribution(session.id, { chatRepo, termsRepo, notesRepo, claude });

      expect(proposal.proposedTerms).toHaveLength(1);
      expect(proposal.proposedTerms[0]).toMatchObject({ term: 'TCP/IP', askedByUser: true });
    });

    it('forces the subject into the proposal even when the AI omitted it as a new term (query mode)', async () => {
      const chatRepo = createChatRepository(db);
      const termsRepo = createTermsRepository(db);
      const notesRepo = createNotesRepository(db);
      // ホーム画面の「AIで検索」で「1」と打ったケースを模す（実際に報告された不具合）
      const session = await chatRepo.createSession(null, '1');
      await chatRepo.appendMessage(session.id, 'user', '1');

      const claude = createScriptedAiClient([
        distributionJson([
          {
            term: '1',
            isTerm: true,
            askedByUser: false, // 修正前はこれが原因で proposedTerms が空になっていた
            summary: '進数や真偽値の文脈で使われる数値。',
            readings: ['イチ'],
            field: '基礎理論',
            draftBody: '2進数における1、あるいは真偽値のtrueを表す値として使われる。',
            diagrams: [],
          },
        ]),
      ]);

      const proposal = await proposeDistribution(session.id, { chatRepo, termsRepo, notesRepo, claude });

      expect(proposal.proposedTerms).toHaveLength(1);
      expect(proposal.proposedTerms[0]).toMatchObject({ term: '1', isNewTerm: true, askedByUser: true });
    });

    it('tells the AI what the subject is in the distribution prompt', async () => {
      const chatRepo = createChatRepository(db);
      const termsRepo = createTermsRepository(db);
      const notesRepo = createNotesRepository(db);
      const session = await chatRepo.createSession(null, 'ゼロトラスト');
      await chatRepo.appendMessage(session.id, 'user', 'ゼロトラスト');

      const claude = createScriptedAiClient([distributionJson([])]);
      await proposeDistribution(session.id, { chatRepo, termsRepo, notesRepo, claude });

      const sentText = claude.calls[0].messages.map((m) => m.content).join('\n');
      expect(sentText).toContain('ゼロトラスト');
      expect(sentText).toContain('主題');
    });

    it('still cannot force-include a subject the AI marked isTerm:false (no content to write)', async () => {
      const chatRepo = createChatRepository(db);
      const termsRepo = createTermsRepository(db);
      const notesRepo = createNotesRepository(db);
      const session = await chatRepo.createSession(null, 'こんにちは');
      await chatRepo.appendMessage(session.id, 'user', 'こんにちは');

      const claude = createScriptedAiClient([distributionJson([{ term: 'こんにちは', isTerm: false, diagrams: [] }])]);
      const proposal = await proposeDistribution(session.id, { chatRepo, termsRepo, notesRepo, claude });

      // isTerm:falseの項目はdraftBody等を持たないため、主題であっても書き込む内容が無い
      // （既知の限界。会話自体は消えず、履歴タブに残って後から取り込み直せる）
      expect(proposal.proposedTerms).toEqual([]);
    });

    it('does not force-include unrelated terms the subject rule should not affect', async () => {
      const chatRepo = createChatRepository(db);
      const termsRepo = createTermsRepository(db);
      const notesRepo = createNotesRepository(db);
      const session = await chatRepo.createSession(null, 'TCP/IP');
      await chatRepo.appendMessage(session.id, 'user', 'TCP/IPって何？ルーティングも絡む？');

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
            askedByUser: false, // 主題ではないので、これまで通り除外される
            summary: '経路を選ぶ仕組み。',
            readings: ['ルーティング'],
            field: 'ネットワーク',
            draftBody: '経路を選ぶ仕組み。',
            diagrams: [],
          },
        ]),
      ]);

      const proposal = await proposeDistribution(session.id, { chatRepo, termsRepo, notesRepo, claude });

      expect(proposal.proposedTerms.map((t) => t.term)).toEqual(['TCP/IP']);
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

  describe('commitProposal（2026-07-30: 承認画面を廃止し常に自動反映する）', () => {
    it('mode:askedOnly writes askedByUser:true items and skips askedByUser:false ones, then commits the session', async () => {
      const chatRepo = createChatRepository(db);
      const termsRepo = createTermsRepository(db);
      const notesRepo = createNotesRepository(db);
      const asksRepo = createAsksRepository(db);
      const session = await chatRepo.createSession(null);

      const existingRouting = buildTermRecord({
        term: 'ルーティング',
        readings: ['ルーティング'],
        summary: '経路制御。',
        field: 'ネットワーク',
        origin: 'seed',
        now: Date.now(),
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

      const { written, skipped } = await commitProposal(proposal, 'askedOnly', {
        termsRepo,
        notesRepo,
        asksRepo,
        chatRepo,
        deviceId: 'device-A',
      });

      expect(written.map((t) => t.term)).toEqual(['TCP/IP']);
      expect(skipped.map((t) => t.term)).toEqual(['ルーティング']);

      // askedByUser:true（TCP/IP）は書き込み済み。新規語なのでAI生成のsummaryも持つ
      const created = await termsRepo.getById(makeTermId('TCP/IP'));
      expect(created?.summary).toBe('層に分けた通信規約の集まり。');
      expect((await notesRepo.getByTermId(makeTermId('TCP/IP')))?.body).toBe('説明A');
      expect(await asksRepo.getByTermId(makeTermId('TCP/IP'))).toHaveLength(1);

      // askedByUser:false（ルーティング）は書き込まれない（mode:askedOnly）
      expect((await notesRepo.getByTermId(makeTermId('ルーティング')))?.body).toBeUndefined();
      expect(await asksRepo.getByTermId(makeTermId('ルーティング'))).toHaveLength(0);

      const openSessions = await chatRepo.getOpenSessions();
      expect(openSessions.map((s) => s.id)).not.toContain(session.id); // committed済み（残り物が無くても必ず確定する）
    });

    it('mode:all writes askedByUser:false updates to existing terms too', async () => {
      const chatRepo = createChatRepository(db);
      const termsRepo = createTermsRepository(db);
      const notesRepo = createNotesRepository(db);
      const asksRepo = createAsksRepository(db);
      const session = await chatRepo.createSession(null);

      const existingRouting = buildTermRecord({
        term: 'ルーティング',
        readings: ['ルーティング'],
        summary: '経路制御。',
        field: 'ネットワーク',
        origin: 'seed',
        now: Date.now(),
      });
      await termsRepo.bulkPutFromSeed([existingRouting]);

      const proposal = {
        sessionId: session.id,
        proposedTerms: [
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

      const { written, skipped } = await commitProposal(proposal, 'all', {
        termsRepo,
        notesRepo,
        asksRepo,
        chatRepo,
        deviceId: 'device-A',
      });

      expect(written.map((t) => t.term)).toEqual(['ルーティング']);
      expect(skipped).toEqual([]);
      expect((await notesRepo.getByTermId(makeTermId('ルーティング')))?.body).toBe('統合済みの説明');
    });

    it('always commits the session, even when there is nothing to write', async () => {
      const chatRepo = createChatRepository(db);
      const termsRepo = createTermsRepository(db);
      const notesRepo = createNotesRepository(db);
      const asksRepo = createAsksRepository(db);
      const session = await chatRepo.createSession(null);

      const proposal = { sessionId: session.id, proposedTerms: [] };

      await commitProposal(proposal, 'askedOnly', { termsRepo, notesRepo, asksRepo, chatRepo, deviceId: 'device-A' });

      const stillOpen = await chatRepo.getOpenSessions();
      expect(stillOpen.map((s) => s.id)).not.toContain(session.id);
    });
  });
});
