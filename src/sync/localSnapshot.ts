import type { LocalSnapshot } from '../core/mergeSnapshot';
import { isSyncTarget } from '../core/syncTarget';
import type { AsksRepository } from '../repositories/asks';
import type { NotesRepository } from '../repositories/notes';
import type { TermsRepository } from '../repositories/terms';

export interface LocalSnapshotDeps {
  notesRepo: NotesRepository;
  asksRepo: AsksRepository;
  termsRepo: TermsRepository;
}

/** mergeSnapshot() への入力。輸送手段に依存しないため Drive/手動同期どちらからも使う */
export async function buildLocalSnapshot(deps: LocalSnapshotDeps): Promise<LocalSnapshot> {
  const [notes, asks, terms] = await Promise.all([
    deps.notesRepo.getAll(),
    deps.asksRepo.getAllOrdered(),
    deps.termsRepo.getAllForSync(),
  ]);
  return { notes, asks, aiTerms: terms.filter(isSyncTarget) };
}
