import { isSyncTarget, type LocalSnapshot } from '@it-index/shared';
import type { AsksRepository } from '../repositories/asks';
import type { NotesRepository } from '../repositories/notes';
import type { TermsRepository } from '../repositories/terms';

export interface LocalSnapshotDeps {
  notesRepo: NotesRepository;
  asksRepo: AsksRepository;
  termsRepo: TermsRepository;
}

/**
 * mergeSnapshot()への入力。v1(../../../src/sync/localSnapshot.ts)と同じ考え方:
 * terms(aiTerms)はisSyncTargetで絞る(origin:'ai'の語+tombstone。core/syncTarget.ts)。
 * notes・asksは全件(mergeSnapshot側がlastEditedBy/deviceIdの突き合わせを行う)。
 */
export async function buildLocalSnapshot(deps: LocalSnapshotDeps): Promise<LocalSnapshot> {
  const [notes, asks, terms] = await Promise.all([
    deps.notesRepo.getAll(),
    deps.asksRepo.getAllOrdered(),
    deps.termsRepo.getAllForSync(),
  ]);
  return { notes, asks, aiTerms: terms.filter(isSyncTarget) };
}
