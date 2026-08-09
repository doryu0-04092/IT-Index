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

  it('両端末がそれぞれ独自に編集した場合は conflicts に積む', () => {
    const local: LocalSnapshot = { notes: [note('tcp', 'from A', 5, 'A')], asks: [], aiTerms: [] };
    const remote = [syncFile('B', [note('tcp', 'from B', 3, 'B')])];

    const result = mergeSnapshot(local, remote);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].termId).toBe('tcp');
  });

  // 回帰: 以前は「内容が違えば競合」としていたため、片方でしか編集していなくても
  // 連携のたびに競合として数え上げられ、確認画面が本物でない競合で埋まっていた。
  it('相手が持っているのが同じ端末の書いた版なら競合にしない（相手は受け取っただけ）', () => {
    // Aで育てた版がBへ渡っただけ。その後Aがさらに育てたので内容は食い違うが、Bは編集していない
    const local: LocalSnapshot = { notes: [note('tcp', 'Aの新しい版', 5, 'A')], asks: [], aiTerms: [] };
    const remote = [syncFile('B', [note('tcp', 'Aの古い版', 3, 'A')])];

    expect(mergeSnapshot(local, remote).conflicts).toHaveLength(0);
  });

  it('相手の内容がこちらの過去版そのものなら競合にしない（相手が遅れているだけ）', () => {
    const localNote: NoteRecord = {
      termId: 'tcp',
      body: '最新版',
      diagrams: [],
      updatedAt: 5,
      lastEditedBy: 'A',
      noteHistory: [{ body: '前の版', diagrams: [], updatedAt: 3 }],
    };
    const local: LocalSnapshot = { notes: [localNote], asks: [], aiTerms: [] };
    // B が持っているのは、こちらが上書きする前の版そのもの
    const remote = [syncFile('B', [note('tcp', '前の版', 3, 'B')])];

    expect(mergeSnapshot(local, remote).conflicts).toHaveLength(0);
  });

  it('過去版に無い内容を相手が持っていれば競合として残す', () => {
    const localNote: NoteRecord = {
      termId: 'tcp',
      body: '最新版',
      diagrams: [],
      updatedAt: 5,
      lastEditedBy: 'A',
      noteHistory: [{ body: '前の版', diagrams: [], updatedAt: 3 }],
    };
    const local: LocalSnapshot = { notes: [localNote], asks: [], aiTerms: [] };
    const remote = [syncFile('B', [note('tcp', 'Bが独自に書いた版', 4, 'B')])];

    expect(mergeSnapshot(local, remote).conflicts).toHaveLength(1);
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
