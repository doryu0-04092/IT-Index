import type { NotesRepository } from '../repositories/notes';
import type { TermsRepository } from '../repositories/terms';
import { buildNoteFile } from './noteFile';
import { buildLocalTermsFile } from './termsFile';

export interface LocalDataExport {
  /** `data/terms.json` に書き込む内容（整形済みJSON文字列） */
  termsJson: string;
  /** `data/notes/<termId>.md` に書き込む内容の一覧 */
  notes: { termId: string; content: string }[];
}

/**
 * IndexedDB から `data/terms.json` + `data/notes/*.md` の書き出し内容を組み立てる。
 * 対象は origin:'ai' の語（`buildLocalTermsFile` 参照）と、内容のあるノート全件。
 * seed 語のノート（AIチャットで補足された既存語）も notes には含める
 * ——notes は語の origin を問わず「本文があるかどうか」だけで判定する。
 */
export async function buildLocalDataExport(
  deps: { termsRepo: TermsRepository; notesRepo: NotesRepository },
  version: string,
): Promise<LocalDataExport> {
  const allTerms = await deps.termsRepo.getAll();
  const aiTerms = allTerms.filter((t) => t.origin === 'ai');
  const termsFile = buildLocalTermsFile(aiTerms, version);

  const termById = new Map(allTerms.map((t) => [t.id, t]));
  const allNotes = await deps.notesRepo.getAll();

  const notes: { termId: string; content: string }[] = [];
  for (const note of allNotes) {
    if (note.body.trim() === '' && note.diagrams.length === 0) continue;
    const term = termById.get(note.termId);
    if (!term) continue; // 対応する語が無い（削除済み等）ノートは書き出さない
    notes.push({ termId: note.termId, content: buildNoteFile(term, note) });
  }

  return { termsJson: JSON.stringify(termsFile, null, 2), notes };
}
