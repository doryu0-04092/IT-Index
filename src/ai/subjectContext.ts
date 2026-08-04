import type { NotesRepository } from '../repositories/notes';
import type { TermsRepository } from '../repositories/terms';
import type { Field } from '../types';

/**
 * docs/requirements.md §5.3「チャットの主題（SubjectContext）」/ docs/ai-client.md §2。
 * どの語について話しているかをAIに推測させず、利用者の操作（どの語を選んだか）で確定させる。
 *
 * 2026-08-05: 主題を確定させない「自由モード」を廃止した（リリース対象に含めないという判断）。
 * チャットは必ずいずれかの語にひも付く。
 */
export interface SubjectContext {
  mode: 'term';
  termId: string;
  label: string;
  field: Field;
  readings: string[];
  existingSummary: string | null;
  existingNoteBody: string | null;
}

/**
 * 既存の初期説明・AI補足を辞書から取得し、グラウンディング用に持たせる。
 * 語が見つからない（削除済み等）場合は null を返す——主題を確定できない以上チャットは始められない。
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
