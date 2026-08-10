import type { Field } from '@it-index/shared';
import type { NotesRepository } from '../repositories/notes';
import type { TermsRepository } from '../repositories/terms';

/**
 * docs/requirements.md §5.3「チャットの主題(SubjectContext)」/ docs/ai-client.md §2
 * (v1 ../../../src/ai/subjectContext.ts参照。仕様は変えずv2の型に載せ替えたのみ)。
 * どの語について話しているかをAIに推測させず、利用者の操作(どの語を選んだか／何と
 * 入力したか)で確定させる。v1の`mode:'free'`は既に廃止済みのため移植しない。
 */
export type SubjectContext =
  | {
      mode: 'term';
      termId: string;
      label: string;
      field: Field;
      readings: string[];
      existingSummary: string | null;
      existingNoteBody: string | null;
    }
  | {
      mode: 'query';
      /** 利用者が検索欄に入力した文字列そのもの */
      label: string;
    };

/** 検索欄の入力文字列をそのまま主題にする(辞書引きをしないので同期的に作れる) */
export function buildQuerySubject(query: string): SubjectContext {
  return { mode: 'query', label: query.trim() };
}

/**
 * 既存の初期説明・AI補足を辞書から取得し、グラウンディング用に持たせる。
 * 語が見つからない(削除済み等)場合はnullを返す——主題を確定できない以上チャットは始められない。
 */
export async function buildSubjectContext(
  termId: string,
  deps: { termsRepo: TermsRepository; notesRepo: NotesRepository },
): Promise<SubjectContext | null> {
  const term = await deps.termsRepo.getById(termId);
  if (!term) return null;

  const note = await deps.notesRepo.getByTermId(termId);
  return {
    mode: 'term',
    termId,
    label: term.term,
    field: term.field,
    readings: term.readings,
    existingSummary: term.summary,
    existingNoteBody: note && note.body.trim() !== '' ? note.body : null,
  };
}
