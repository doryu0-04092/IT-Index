import type { AsksRepository } from '../repositories/asks';
import type { ChatRepository } from '../repositories/chat';
import type { NotesRepository } from '../repositories/notes';
import { buildTermRecord, makeTermId, type TermsRepository } from '../repositories/terms';
import type { Field } from '../types';
import type { AiClient, AiMessage } from './aiClient';
import { parseDistributionResponse } from './parseDistribution';
import { parseMergeResponse } from './parseMerge';
import { buildDistributionMessages, buildMergeMessages, DISTRIBUTION_SYSTEM_PROMPT, MERGE_SYSTEM_PROMPT } from './prompts';

/** 分配統合の候補1語ぶん。isTerm:false の項目は最初から含まれない */
export interface ProposedTerm {
  term: string;
  termId: string;
  /** 辞書に無い語か */
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
 * docs/architecture.md §4.1 の「確定」〜分配案の組み立てまで。DBへは一切書き込まない
 * （書き込みは commitProposal() に分離してある。要件定義書§5.3改訂〔2026-07-30〕：
 * 承認画面は廃止し、分配案は常に自動でDBへ反映される。分岐は書き込み時の
 * commitProposal() 側が担う）。
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
    // AIが別の語を説明する過程で触れただけの語まで新規登録候補にすると、会話1回につき
    // 無関係な新規語が何件も自動登録されてしまう（要件定義書§5.3）。この絞り込みは
    // autoUpdateExistingTerms設定の対象外——新規登録は常にこのルール1本で決まる。
    // 既存語への追記（統合）はこの絞り込みの対象外（MERGE_SYSTEM_PROMPTの非破壊ルールで安全性を担保済み。
    // 自動反映するかどうかは commitProposal() 側の autoUpdateExistingTerms 設定で決める）。
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
 * 実際のDB書き込み（terms/notes/asks）だけを行う共通処理。セッションの commit 状態には触れない
 * （chatRepo.commitSession() は呼び出し元の commitProposal() が呼ぶ）。
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

/** 既存語への自動反映の範囲。要件定義書§5.3・設定画面の「既存語の自動更新」に対応する */
export type AutoUpdateExistingTermsMode = 'askedOnly' | 'all';

/**
 * 要件定義書§5.3改訂（2026-07-30）: 承認画面を廃止し、分配案は常に自動でDBへ反映する。
 *
 * - 新規登録になる語は、proposeDistribution() の時点で既に askedByUser:true のものしか
 *   候補に残っていない（上記の絞り込み参照）ので、常に書き込む対象になる
 *   ——「利用者が検索・質問した語だけ新規登録する」を満たす
 * - 既存語への追記は `mode` に従う:
 *   - `askedOnly`（既定）: `askedByUser: true` の語だけ書き込む。会話の中で他の語に
 *     ついて説明された際、ついでに触れられただけの既存語（askedByUser:false）は書き込まない
 *   - `all`: askedByUser の値に関わらず、候補に残った既存語への追記もすべて書き込む
 *     （「他の単語を調べた際に出てきた情報も自動更新する」設定）
 *
 * 書き込んだ後、必ず chatSessions を commitSession() する（承認待ちで宙に浮く状態が無いため、
 * 分岐なしで毎回呼べる）。
 */
export async function commitProposal(
  proposal: DistributionProposal,
  mode: AutoUpdateExistingTermsMode,
  deps: {
    termsRepo: TermsRepository;
    notesRepo: NotesRepository;
    asksRepo: AsksRepository;
    chatRepo: ChatRepository;
    deviceId: string;
  },
): Promise<{ written: ProposedTerm[]; skipped: ProposedTerm[] }> {
  const written = mode === 'all' ? proposal.proposedTerms : proposal.proposedTerms.filter((t) => t.askedByUser);
  const skipped = mode === 'all' ? [] : proposal.proposedTerms.filter((t) => !t.askedByUser);

  await writeTerms(proposal.sessionId, written, deps);
  await deps.chatRepo.commitSession(proposal.sessionId);

  return { written, skipped };
}
