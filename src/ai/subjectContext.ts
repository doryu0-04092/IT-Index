import type { NotesRepository } from '../repositories/notes';
import type { TermsRepository } from '../repositories/terms';
import type { Field } from '../types';

/**
 * docs/requirements.md §5.3「チャットの主題（SubjectContext）」/ docs/ai-client.md §2。
 * どの語について話しているかをAIに推測させず、利用者の操作（どの語を選んだか／何と入力したか）で確定させる。
 *
 * 2026-08-05: 主題を一切確定させない「自由モード」を廃止した。
 * 2026-08-06: 代わりに `mode:'query'` を追加した。ホーム画面の検索欄に入力した文字列を
 * そのまま主題にしてAIに聞く導線（「AIで検索」）のためのもので、主題が無いのではなく
 * **利用者が入力した文字列が主題**である点が旧・自由モードとの違い。辞書に無い語こそ
 * AIに聞きたい、という要望に応えるために必要（辞書に登録してからでないと聞けないと、
 * 聞いてみただけの語で単語帳が汚れる）。この段階では辞書に何も書き込まず、
 * 実際の登録は従来どおり「取り込み」時にAIが判断する。
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

/** 検索欄の入力文字列をそのまま主題にする（辞書引きをしないので同期的に作れる） */
export function buildQuerySubject(query: string): SubjectContext {
  return { mode: 'query', label: query.trim() };
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
