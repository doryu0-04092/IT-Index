import { buildTermRecord, makeTermId, type Field } from '@it-index/shared';
import type { AsksRepository } from '../repositories/asks';
import type { ChatRepository } from '../repositories/chat';
import type { NotesRepository } from '../repositories/notes';
import type { TermsRepository } from '../repositories/terms';
import type { AiClient, AiMessage } from './aiClient';
import { parseDistributionResponse } from './parseDistribution';
import { parseMergeResponse } from './parseMerge';
import { buildDistributionMessages, buildMergeMessages, DISTRIBUTION_SYSTEM_PROMPT, MERGE_SYSTEM_PROMPT } from './prompts';

/**
 * v1(../../../src/ai/distribution.ts)から仕様を変えずに移植する(依頼書「分配統合の
 * プロンプトもv1から移植」)。AiClient.send()の戻り値がAiSendResult(text以外にstopReasonも
 * 持つ)に変わったため、ここでは`.text`だけを取り出して従来どおりparse系関数に渡す。
 */

/** 分配統合の候補1語ぶん。isTerm:falseの項目は最初から含まれない */
export interface ProposedTerm {
  term: string;
  termId: string;
  /** 辞書に無い語か */
  isNewTerm: boolean;
  /** ユーザー自身がこの語について明示的に尋ねたか。自動保存の可否判定に使う(commitOrchestrator.ts) */
  askedByUser: boolean;
  /** 新規語登録時のみ使う初期説明の一文。既存語では使わない(summaryは不変のため) */
  summary: string;
  readings: string[];
  field: Field;
  /** 最終本文。既存語なら統合済み、新規語ならAIの起こし書きそのまま */
  finalBody: string;
  diagrams: string[];
}

export interface DistributionProposal {
  sessionId: string;
  proposedTerms: ProposedTerm[];
}

/**
 * 分配案の組み立て。DBへは一切書き込まない(書き込みはcommitProposal()に分離してある)。
 */
export async function proposeDistribution(
  sessionId: string,
  deps: { chatRepo: ChatRepository; termsRepo: TermsRepository; notesRepo: NotesRepository; aiClient: AiClient },
): Promise<DistributionProposal> {
  // この会話の主題(利用者が選んだ語、または「AIで検索」に打った文字列)。
  // 要件定義書§5.3「主題の語は必ず登録候補にする」対応。
  const session = await deps.chatRepo.getSession(sessionId);
  const subjectTerm = session?.termId ? await deps.termsRepo.getById(session.termId) : null;
  const subjectLabel = subjectTerm?.term ?? session?.subjectLabel ?? null;
  // 主題の語かどうかの突き合わせはtermId基準(正規化済み)で行う。
  const subjectMatchId = session?.termId ?? (subjectLabel ? makeTermId(subjectLabel) : null);

  const history = await deps.chatRepo.getMessages(sessionId);
  const messages: AiMessage[] = buildDistributionMessages(
    history.map((m) => ({ role: m.role, content: m.content })),
    subjectLabel,
  );

  const raw = await deps.aiClient.send({ system: DISTRIBUTION_SYSTEM_PROMPT, messages });
  const parsed = parseDistributionResponse(raw.text);
  if (!parsed.ok) {
    throw new Error(`分配統合の出力を解釈できませんでした: ${parsed.reason}`);
  }

  const proposedTerms: ProposedTerm[] = [];
  for (const item of parsed.items) {
    // isTerm:falseの項目はdraftBody等を一切持たない(判別共用体)ため、主題であっても
    // 書き込む内容が無い。AIがプロンプトの指示に従わなかった場合はここで諦めるしかない
    // ——ただし会話自体は消えない(検索画面「取り込み待ち」に残り、後から取り込み直せる)。
    if (!item.isTerm) continue;

    const termId = makeTermId(item.term);
    const isSubject = subjectMatchId !== null && termId === subjectMatchId;
    const existingTerm = await deps.termsRepo.getById(termId);

    // 辞書に無い語(=新規登録になる語)は、ユーザー自身が明示的に尋ねた場合のみ候補にする。
    // 既存語への追記(統合)はこの絞り込みの対象外(MERGE_SYSTEM_PROMPTの非破壊ルールで
    // 安全性を担保済み)。主題の語だけはこの絞り込みの対象外——AIのaskedByUser判定に
    // 関わらず必ず候補に残す。
    if (!existingTerm && !item.askedByUser && !isSubject) continue;

    const existingNote = existingTerm ? await deps.notesRepo.getByTermId(termId) : undefined;

    let finalBody = item.draftBody;
    let diagrams = item.diagrams;

    if (existingNote && existingNote.body.trim() !== '') {
      const mergeMessages = buildMergeMessages(
        item.term,
        existingNote.body,
        existingNote.diagrams,
        item.draftBody,
        item.diagrams,
      );
      try {
        const mergedRaw = await deps.aiClient.send({ system: MERGE_SYSTEM_PROMPT, messages: mergeMessages });
        const mergedParsed = parseMergeResponse(mergedRaw.text);
        if (mergedParsed.ok) {
          finalBody = mergedParsed.result.body;
          diagrams = mergedParsed.result.diagrams;
        }
        // 統合の出力が不正な場合はdraftBodyをそのまま使う(機能を止めない)
      } catch {
        // 統合呼び出し自体が失敗した場合も同様にフォールバックする
      }
    }

    proposedTerms.push({
      term: item.term,
      termId,
      isNewTerm: !existingTerm,
      // 主題の語は、AIがaskedByUser:falseと判定していても強制的にtrueにする。
      askedByUser: item.askedByUser || isSubject,
      summary: item.summary,
      readings: item.readings,
      field: item.field,
      finalBody,
      diagrams,
    });
  }

  return { sessionId, proposedTerms };
}

/** 実際のDB書き込み(terms/notes/asks)だけを行う共通処理。セッションのcommit状態には触れない */
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

/** 既存語への自動反映の範囲。要件定義書§5.3・SettingsRecord.autoUpdateExistingTermsに対応する */
export type AutoUpdateExistingTermsMode = 'askedOnly' | 'all';

/**
 * 分配案の常時自動反映(要件定義書§5.3「承認画面は廃止」)。
 * - `mode === 'all'`ならproposal.proposedTermsを全件書き込む
 * - `mode === 'askedOnly'`(既定)ならaskedByUser:trueの項目だけ書き込み、falseはskippedに回す
 * - 新規登録になる語はproposeDistribution()の時点で既にaskedByUser:trueのものしか
 *   候補に残っていないので、modeに関わらず新規登録の判定は変わらない
 * - 最後に必ずchatSessionsをcommitSession()する(承認待ちで宙に浮く状態が無いため、
 *   書き込み対象が0件でも毎回呼べる)
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
