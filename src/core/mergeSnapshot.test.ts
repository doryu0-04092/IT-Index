import { describe, expect, it } from 'vitest';
import type { AskRecord, NoteRecord } from '../types';
import { mergeSnapshot, type LocalSnapshot, type SyncFile } from './mergeSnapshot';

function note(termId: string, body: string, updatedAt: number, lastEditedBy: string): NoteRecord {
  return { termId, body, diagrams: [], updatedAt, lastEditedBy, noteHistory: [] };
}

function ask(id: string, termId: string): AskRecord {
  return { id, termId, sessionId: 's', at: 1, deviceId: 'd', source: 'ai' };
}

function syncFile(deviceId: string, notes: NoteRecord[], asks: AskRecord[] = []): SyncFile {
  return { syncSchemaVersion: 1, deviceId, writtenAt: 1, notes, asks, aiTerms: [] };
}

describe('mergeSnapshot', () => {
  it('notes は updatedAt が新しい方を採用する', () => {
    const local: LocalSnapshot = { notes: [note('tcp', 'old', 1, 'A')], asks: [], aiTerms: [] };
    const remote = [syncFile('B', [note('tcp', 'new', 2, 'B')])];

    const result = mergeSnapshot(local, remote);
    expect(result.notes[0].body).toBe('new');
  });

  it('両端末で内容が食い違う場合は conflicts に積む', () => {
    const local: LocalSnapshot = { notes: [note('tcp', 'from A', 5, 'A')], asks: [], aiTerms: [] };
    const remote = [syncFile('B', [note('tcp', 'from B', 3, 'B')])];

    const result = mergeSnapshot(local, remote);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].termId).toBe('tcp');
  });

  it('asks は id の和集合になる（重複除去）', () => {
    const local: LocalSnapshot = { notes: [], asks: [ask('1', 'tcp')], aiTerms: [] };
    const remote = [syncFile('B', [], [ask('1', 'tcp'), ask('2', 'udp')])];

    const result = mergeSnapshot(local, remote);
    expect(result.asks.map((a) => a.id).sort()).toEqual(['1', '2']);
  });

  it('同じスナップショットを2回マージしても結果が変わらない（冪等性）', () => {
    const local: LocalSnapshot = { notes: [note('tcp', 'x', 1, 'A')], asks: [ask('1', 'tcp')], aiTerms: [] };
    const remote = [syncFile('B', [note('tcp', 'y', 2, 'B')], [ask('2', 'tcp')])];

    const first = mergeSnapshot(local, remote);
    const second = mergeSnapshot(local, remote);
    expect(second).toEqual(first);
  });
});
