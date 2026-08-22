import { describe, expect, it } from 'vitest';
import type { NoteRecord } from '@it-index/shared';
import type { NoteConflictRecord } from '../types';
import { groupConflictsByTerm, localSideOf, MAX_CONFLICT_DEVICES } from './groupConflicts';

function note(body: string, updatedAt: number, lastEditedBy: string): NoteRecord {
  return { termId: 'term-a', body, diagrams: [], updatedAt, lastEditedBy, resolvedAt: null, noteHistory: [] };
}

function conflict(overrides: {
  id: string;
  termId?: string;
  peerDeviceId: string;
  detectedAt: number;
  remoteUpdatedAt: number;
  localUpdatedAt?: number;
}): NoteConflictRecord {
  return {
    id: overrides.id,
    termId: overrides.termId ?? 'term-a',
    detectedAt: overrides.detectedAt,
    peerDeviceId: overrides.peerDeviceId,
    local: note('この端末', overrides.localUpdatedAt ?? 100, 'device-me'),
    remote: note(`${overrides.peerDeviceId}の内容`, overrides.remoteUpdatedAt, overrides.peerDeviceId),
    resolution: null,
    merged: null,
    resolvedAt: null,
    syncEventId: 'event-1',
    closedReason: null,
    closedAt: null,
  };
}

describe('groupConflictsByTerm', () => {
  it('同じ単語の競合を1つにまとめる', () => {
    const groups = groupConflictsByTerm([
      conflict({ id: 'c1', peerDeviceId: 'device-b', detectedAt: 100, remoteUpdatedAt: 100 }),
      conflict({ id: 'c2', peerDeviceId: 'device-c', detectedAt: 100, remoteUpdatedAt: 200 }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].termId).toBe('term-a');
    expect(groups[0].conflicts).toHaveLength(2);
  });

  it('グループ内はノートの更新が新しい順(選ぶ価値が高いものを上に)', () => {
    const groups = groupConflictsByTerm([
      conflict({ id: 'old', peerDeviceId: 'device-b', detectedAt: 100, remoteUpdatedAt: 100 }),
      conflict({ id: 'new', peerDeviceId: 'device-c', detectedAt: 100, remoteUpdatedAt: 300 }),
      conflict({ id: 'mid', peerDeviceId: 'device-d', detectedAt: 100, remoteUpdatedAt: 200 }),
    ]);

    expect(groups[0].conflicts.map((c) => c.id)).toEqual(['new', 'mid', 'old']);
  });

  it('別の単語は別のグループになる', () => {
    const groups = groupConflictsByTerm([
      conflict({ id: 'c1', termId: 'term-a', peerDeviceId: 'device-b', detectedAt: 100, remoteUpdatedAt: 1 }),
      conflict({ id: 'c2', termId: 'term-b', peerDeviceId: 'device-b', detectedAt: 200, remoteUpdatedAt: 1 }),
    ]);

    expect(groups).toHaveLength(2);
    // 検出が新しい語が上
    expect(groups[0].termId).toBe('term-b');
  });

  it('グループ同士は最新の検出が新しい順(同じ語で再発したら上に来る)', () => {
    const groups = groupConflictsByTerm([
      conflict({ id: 'a1', termId: 'term-a', peerDeviceId: 'device-b', detectedAt: 100, remoteUpdatedAt: 1 }),
      conflict({ id: 'b1', termId: 'term-b', peerDeviceId: 'device-b', detectedAt: 200, remoteUpdatedAt: 1 }),
      // term-a で新しく再発した
      conflict({ id: 'a2', termId: 'term-a', peerDeviceId: 'device-c', detectedAt: 300, remoteUpdatedAt: 1 }),
    ]);

    expect(groups.map((g) => g.termId)).toEqual(['term-a', 'term-b']);
    expect(groups[0].latestDetectedAt).toBe(300);
  });

  it(`${MAX_CONFLICT_DEVICES}台までに絞り、落とした件数を返す`, () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      conflict({
        id: `c${i}`,
        peerDeviceId: `device-${i}`,
        detectedAt: 100,
        remoteUpdatedAt: i, // 0が最も古い
      }),
    );

    const groups = groupConflictsByTerm(many);

    expect(groups[0].conflicts).toHaveLength(MAX_CONFLICT_DEVICES);
    expect(groups[0].hiddenCount).toBe(2);
    // 落ちるのは更新が古い側(c0・c1)
    expect(groups[0].conflicts.map((c) => c.id)).toEqual(['c6', 'c5', 'c4', 'c3', 'c2']);
  });

  it('上限以下なら落とす件数は0', () => {
    const groups = groupConflictsByTerm([
      conflict({ id: 'c1', peerDeviceId: 'device-b', detectedAt: 100, remoteUpdatedAt: 1 }),
    ]);
    expect(groups[0].hiddenCount).toBe(0);
  });

  it('空の入力では空を返す', () => {
    expect(groupConflictsByTerm([])).toEqual([]);
  });
});

describe('localSideOf', () => {
  it('最も新しく検出された競合の「この端末の内容」を採る', () => {
    const groups = groupConflictsByTerm([
      conflict({ id: 'old', peerDeviceId: 'device-b', detectedAt: 100, remoteUpdatedAt: 1, localUpdatedAt: 10 }),
      conflict({ id: 'new', peerDeviceId: 'device-c', detectedAt: 300, remoteUpdatedAt: 1, localUpdatedAt: 30 }),
    ]);

    expect(localSideOf(groups[0]).id).toBe('new');
    expect(localSideOf(groups[0]).local.updatedAt).toBe(30);
  });
});
