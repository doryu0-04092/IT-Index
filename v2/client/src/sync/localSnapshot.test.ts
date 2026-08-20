import 'fake-indexeddb/auto';
import { buildTermRecord } from '@it-index/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { ItIndexDB } from '../db';
import { createAsksRepository } from '../repositories/asks';
import { createNotesRepository } from '../repositories/notes';
import { createTermsRepository } from '../repositories/terms';
import { buildLocalSnapshot } from './localSnapshot';

/**
 * mergeSnapshot()への入力の組み立て(#171でテストを追加)。ここで語の絞り込みを誤ると
 * 「自分の語が相手に届かない」「シード語まで送ってしまう」の両方が起きるため、
 * isSyncTargetの適用範囲を固定する。
 */
describe('buildLocalSnapshot', () => {
  const dbs: ItIndexDB[] = [];
  afterEach(() => {
    for (const db of dbs) db.close();
    dbs.length = 0;
  });

  function deps() {
    const db = new ItIndexDB(`test-localSnapshot-${Math.random()}`);
    dbs.push(db);
    return { db, notesRepo: createNotesRepository(db), asksRepo: createAsksRepository(db), termsRepo: createTermsRepository(db) };
  }

  it('aiTermsはorigin:aiの語のみを含み、非削除のシード語は含まない', async () => {
    const d = deps();
    await d.termsRepo.bulkPutFromSeed([
      buildTermRecord({ term: 'シード語', readings: ['シード'], summary: 'x', field: '基礎理論', origin: 'seed', now: 1 }),
      buildTermRecord({ term: 'AI語', readings: ['エーアイ'], summary: null, field: 'AI', origin: 'ai', now: 1 }),
    ]);

    const snapshot = await buildLocalSnapshot(d);

    expect(snapshot.aiTerms.map((t) => t.term)).toEqual(['AI語']);
  });

  it('削除したシード語(tombstone)は含める(削除を相手へ伝えるため)', async () => {
    const d = deps();
    const seed = buildTermRecord({ term: 'シード語', readings: ['シード'], summary: 'x', field: '基礎理論', origin: 'seed', now: 1 });
    await d.termsRepo.bulkPutFromSeed([seed]);
    await d.termsRepo.softDelete(seed.id, 500);

    const snapshot = await buildLocalSnapshot(d);

    expect(snapshot.aiTerms).toHaveLength(1);
    expect(snapshot.aiTerms[0].deletedAt).toBe(500);
  });

  it('notes・asksは全件を含む(絞り込みはしない)', async () => {
    const d = deps();
    await d.notesRepo.saveBody('term-a', '本文A', 'device-1', 100);
    await d.notesRepo.saveBody('term-b', '本文B', 'device-1', 200);
    await d.asksRepo.addSearchConfirm('term-a', 'device-1', 100);

    const snapshot = await buildLocalSnapshot(d);

    expect(snapshot.notes.map((n) => n.termId).sort()).toEqual(['term-a', 'term-b']);
    expect(snapshot.asks).toHaveLength(1);
  });

  it('データが無い端末では空のスナップショットになる(初回同期)', async () => {
    const snapshot = await buildLocalSnapshot(deps());

    expect(snapshot).toEqual({ notes: [], asks: [], aiTerms: [] });
  });
});
