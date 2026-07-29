import type { AsksRepository } from '../repositories/asks';
import type { ChatRepository } from '../repositories/chat';
import type { NotesRepository } from '../repositories/notes';
import { buildTermRecord, makeTermId, type TermsRepository } from '../repositories/terms';
import type { Field } from '../types';
import type { AiClient, AiMessage } from './aiClient';
import { parseDistributionResponse } from './parseDistribution';
import { parseMergeResponse } from './parseMerge';
import { buildDistributionMessages, buildMergeMessages, DISTRIBUTION_SYSTEM_PROMPT, MERGE_SYSTEM_PROMPT } from './prompts';

/** 承認画面に出す1語ぶんの提案。isTerm:false の項目は最初から含まれない */
export interface ProposedTerm {
  term: string;
  termId: string;
  /** 辞書に無い語か。承認画面での「新規語には印を付ける」（要件定義書§5.3）に使う */
  isNewTerm: boolean;
  /** ユーザー自身がこの語について明示的に尋ねたか。自動保存の可否判定に使う（commitOrchestrator.ts） */
  askedByUser: boolean;
  /** 新規語登録時のみ使う初期説明の一文。既存語では使わない（summaryは不変のため） */
  summary: string;
  readings: string[];
  field: Field;
  /** 承認画面に出す最終本文。既存語なら統合済み、新規語ならAIの起こし書きそのまま */
  finalBody: string;
  diagrams: string[];
}

export interface DistributionProposal {
  sessionId: string;
  proposedTerms: ProposedTerm[];
}

/**
 * docs/architecture.md §4.1 の「確定」〜「承認画面」まで。DBへは一切書き込まない
 * （承認は必ず挟む、という要件定義書§5.3の方針をコードでも徹底するため、
 * 書き込みは applyDistribution() に分離してある）。
 */
export async function proposeDistribution(
  sessionId: string,
  deps: { chatRepo: ChatRepository; termsRepo: TermsRepository; notesRepo: NotesRepository; claude: AiClient },
): Promise<DistributionProposal> {
  const history = await deps.chatRepo.getMessages(sessionId);
  const messages: AiMessage[] = buildDistributionMessages(history.map((m) => ({ role: m.role, content: m.content })));

  const raw = await deps.claude.send({ system: DISTRIBUTION_SYSTEM_PROMPT, messages });
  const parsed = parseDistributionResponse(raw);
  if (!parsed.ok) {
    throw new Error(`分配統合の出力を解釈できませんでした: ${parsed.reason}`);
  }

  const proposedTerms: ProposedTerm[] = [];
  for (const item of parsed.items) {
    if (!item.isTerm) continue;

    const termId = makeTermId(item.term);
    const existingTerm = await deps.termsRepo.getById(termId);

    // 辞書に無い語（＝新規登録になる語）は、ユーザー自身が明示的に尋ねた場合のみ候補にする。
    // AIが別の語を説明する過程で触れただけの語まで新規登録候補に上げると、
    // 会話1回につき無関係な新規語が何件も承認画面に並ぶことになるため（要件定義書§5.3）。
    // 既存語への追記（統合）はこの絞り込みの対象外（MERGE_SYSTEM_PROMPTの非破壊ルールで安全性を担保済み）。
    if (!existingTerm && !item.askedByUser) continue;

    const existingNote = existingTerm ? await deps.notesRepo.getByTermId(termId) : undefined;

    let finalBody = item.draftBody;
    let diagrams = item.diagrams;

    if (existingNote && existingNote.body.trim() !== '') {
      const mergeMessages = buildMergeMessages(item.term, existingNote.body, existingNote.diagrams, item.draftBody, item.diagrams);
      try {
        const mergedRaw = await deps.claude.send({ system: MERGE_SYSTEM_PROMPT, messages: mergeMessages });
        const mergedParsed = parseMergeResponse(mergedRaw);
        if (mergedParsed.ok) {
          finalBody = mergedParsed.result.body;
          diagrams = mergedParsed.result.diagrams;
        }
        // 統合の出力が不正な場合は draftBody をそのまま使う（機能を止めない）
      } catch {
        // 統合呼び出し自体が失敗した場合も同様にフォールバックする
      }
    }

    proposedTerms.push({
      term: item.term,
      termId,
      isNewTerm: !existingTerm,
      askedByUser: item.askedByUser,
      summary: item.summary,
      readings: item.readings,
      field: item.field,
      finalBody,
      diagrams,
    });
  }

  return { sessionId, proposedTerms };
}

/**
 * 実際のDB書き込み（terms/notes/asks）だけを行う共通処理。セッションの commit 状態には
 * 触れない——呼び出し元（承認画面経由の applyDistribution、自動保存の autoApplyAskedTerms）
 * それぞれが、自分の文脈で「これで確定処理が完了したか」を判断して chatRepo.commitSession() を呼ぶ。
 */
async function writeTerms(
  sessionId: string,
  items: ProposedTerm[],
  deps: { termsRepo: TermsRepository; notesRepo: NotesRepository; asksRepo: AsksRepository; deviceId: string },
): Promise<void> {
  if (items.length === 0) return;
  const now = Date.now();

  for (const item of items) {
    if (item.isNewTerm) {
      const record = buildTermRecord({
        term: item.term,
        readings: item.readings,
        summary: item.summary,
        field: item.field,
        origin: 'ai',
        now,
      });
      await deps.termsRepo.upsertFromAi(record);
    }
    await deps.notesRepo.applyCommit(item.termId, item.finalBody, item.diagrams, deps.deviceId, now);
  }

  await deps.asksRepo.addMany(
    items.map((item) => ({ termId: item.termId, sessionId, at: now, deviceId: deps.deviceId, source: 'ai' })),
  );
}

/**
 * 承認された項目だけを1トランザクション相当の一連の書き込みで反映する。
 * commitSession は冪等なので、この関数自体を2回呼んでも補足が二重にならない
 * （ただし2回目は notes が既に更新済みの状態に再度同じ内容を書くだけ、asks は毎回追加される
 * 点に注意。再実行を許容する場面では呼び出し側で防止すること）。
 */
export async function applyDistribution(
  proposal: DistributionProposal,
  approvedTermIds: ReadonlySet<string>,
  deps: {
    termsRepo: TermsRepository;
    notesRepo: NotesRepository;
    asksRepo: AsksRepository;
    chatRepo: ChatRepository;
    deviceId: string;
  },
): Promise<void> {
  const approved = proposal.proposedTerms.filter((t) => approvedTermIds.has(t.termId));
  await writeTerms(proposal.sessionId, approved, deps);
  await deps.chatRepo.commitSession(proposal.sessionId);
}

/**
 * 要件定義書§5.3改訂（2026-07-29）: askedByUser=true の語（＝利用者が会話中に明示的に
 * 尋ねた語）は、承認画面を経由せず自動でDBへ書き込む。既存語への追記も新規語登録も対象——
 * 新規語は proposeDistribution() の時点で既に askedByUser=true のものしか候補に残らないため
 * 「利用者が確認してきた語だけ自動登録・自動更新」を満たす。askedByUser=false（＝既存語への
 * 言及だが、利用者自身は尋ねていない）はここでは書き込まず、従来どおり承認画面に回す
 * ——利用者が明示的に確認していない変更を無断でDBに反映しないため。
 *
 * このオーケストレーション自体はDBに書き込むが、chatSessions の commitSession は呼ばない
 * （呼び出し元の commitOrchestrator が、残りの承認待ちが無いかどうかで判断する）。
 */
export async function autoApplyAskedTerms(
  proposal: DistributionProposal,
  deps: { termsRepo: TermsRepository; notesRepo: NotesRepository; asksRepo: AsksRepository; deviceId: string },
): Promise<{ autoApplied: ProposedTerm[]; remaining: ProposedTerm[] }> {
  const autoApplied = proposal.proposedTerms.filter((t) => t.askedByUser);
  const remaining = proposal.proposedTerms.filter((t) => !t.askedByUser);
  await writeTerms(proposal.sessionId, autoApplied, deps);
  return { autoApplied, remaining };
}
