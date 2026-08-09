import { describe, expect, it } from 'vitest';
import { buildTermRecord } from './term';
import type { NoteRecord } from '../types';
import { computeSyncDelta } from './syncDelta';

function note(termId: string, body: string): NoteRecord {
  return { termId, body, diagrams: [], updatedAt: 1, lastEditedBy: 'device-A', noteHistory: [] };
}

describe('computeSyncDelta', () => {
  it('reports a term as changed when it is new', () => {
    const term = buildTermRecord({ term: 'MTU', readings: ['エムティーユー'], summary: null, field: 'ネットワーク', origin: 'ai', now: 1 });
    const delta = computeSyncDelta({ notes: [], aiTerms: [] }, { notes: [], aiTerms: [term] });
    expect(delta.termIds).toEqual([term.id]);
  });

  it('reports a term as changed when updatedAt differs, unchanged when identical', () => {
    const before = buildTermRecord({ term: 'MTU', readings: ['エムティーユー'], summary: null, field: 'ネットワーク', origin: 'ai', now: 1 });
    const after = { ...before, updatedAt: before.updatedAt + 1 };

    expect(computeSyncDelta({ notes: [], aiTerms: [before] }, { notes: [], aiTerms: [after] }).termIds).toEqual([before.id]);
    expect(computeSyncDelta({ notes: [], aiTerms: [before] }, { notes: [], aiTerms: [before] }).termIds).toEqual([]);
  });

  it('reports a note as changed by content, ignoring updatedAt/lastEditedBy alone', () => {
    const before = note('tcp/ip', '説明');
    const sameContent = { ...before, updatedAt: 999, lastEditedBy: 'device-B' };
    const changedContent = note('tcp/ip', '別の説明');

    expect(computeSyncDelta({ notes: [before], aiTerms: [] }, { notes: [sameContent], aiTerms: [] }).noteTermIds).toEqual([]);
    expect(computeSyncDelta({ notes: [before], aiTerms: [] }, { notes: [changedContent], aiTerms: [] }).noteTermIds).toEqual(['tcp/ip']);
  });

  it('reports a new note (no prior entry) as changed', () => {
    const delta = computeSyncDelta({ notes: [], aiTerms: [] }, { notes: [note('udp', '説明')], aiTerms: [] });
    expect(delta.noteTermIds).toEqual(['udp']);
  });
});
