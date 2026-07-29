import type { NotesRepository } from '../repositories/notes';
import type { TermsRepository } from '../repositories/terms';
import type { Field } from '../types';

/**
 * docs/requirements.md §5.3「チャットの主題（SubjectContext）」/ docs/ai-client.md §2。
 * どの語について話しているかをAIに推測させず、利用者の操作（termIdの有無）で確定させる。
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
  | { mode: 'free'; seedQuery: string | null };

/**
 * termId が確定している場合のみ term モードにする（最上位検索候補への自動ひも付けはしない）。
 * 既存の初期説明・AI補足を辞書から取得し、グラウンディング用に持たせる。
 */
export async function buildSubjectContext(
  termId: string | null,
  seedQuery: string | null,
  deps: { termsRepo: TermsRepository; notesRepo: NotesRepository },
): Promise<SubjectContext> {
  if (termId === null) return { mode: 'free', seedQuery };

  const term = await deps.termsRepo.getById(termId);
  if (!term) return { mode: 'free', seedQuery };

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
