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

  // #157: holdLocalOnConflict(Androidネイティブの規則)。競合時にlocalを保持し、
  // 競合検出時のremote.updatedAt(baseline)より新しい版だけを「相手側(PC)の決定」として採用する。
  describe('holdLocalOnConflict(#157)', () => {
    const options = (baselines?: [string, number][]) => ({
      holdLocalOnConflict: true,
      openConflictBaselines: new Map(baselines ?? []),
    });

    it('競合時はremoteが新しくてもlocalを保持し、競合に積む', () => {
      const local: LocalSnapshot = { notes: [note('tcp', 'from A', 3, 'A')], asks: [], aiTerms: [] };
      const remote = [syncFile('B', [note('tcp', 'from B', 5, 'B')])];

      const result = mergeSnapshot(local, remote, options());
      expect(result.notes[0].body).toBe('from A');
      expect(result.conflicts).toHaveLength(1);
      expect(result.peerDecisions).toEqual([]);
    });

    it('baselineより新しいremote版は相手側の決定として採用し、peerDecisionsに積む', () => {
      const local: LocalSnapshot = { notes: [note('tcp', 'from A', 3, 'A')], asks: [], aiTerms: [] };
      const remote = [syncFile('B', [note('tcp', 'PCの解消結果', 10, 'B')])];

      const result = mergeSnapshot(local, remote, options([['tcp', 5]]));
      expect(result.notes[0].body).toBe('PCの解消結果');
      expect(result.conflicts).toEqual([]);
      expect(result.peerDecisions).toEqual([{ termId: 'tcp', adopted: remote[0].notes[0] }]);
    });

    it('baseline以下のremote版は決定とみなさず、localを保持し続ける', () => {
      const local: LocalSnapshot = { notes: [note('tcp', 'from A', 3, 'A')], asks: [], aiTerms: [] };
      const remote = [syncFile('B', [note('tcp', 'from B', 5, 'B')])];

      // baseline=5(同値)は「競合検出時と同じ版がまだ流れているだけ」なので採用しない
      const result = mergeSnapshot(local, remote, options([['tcp', 5]]));
      expect(result.notes[0].body).toBe('from A');
      expect(result.conflicts).toHaveLength(1);
      expect(result.peerDecisions).toEqual([]);
    });

    it('競合していない語は従来どおりnewest-wins(保持の対象は競合した語だけ)', () => {
      const local: LocalSnapshot = { notes: [note('tcp', 'old', 1, 'A')], asks: [], aiTerms: [] };
      const remote = [syncFile('B', [note('tcp', 'Aの版を受け取って相手が返しただけ', 2, 'A')])];

      // lastEditedBy同一(=競合でない)なのでLWWがそのまま効く
      const result = mergeSnapshot(local, remote, options());
      expect(result.notes[0].body).toBe('Aの版を受け取って相手が返しただけ');
      expect(result.conflicts).toEqual([]);
    });

    it('options付きでも冪等(同じ入力+同じoptionsなら同じ結果)', () => {
      const local: LocalSnapshot = { notes: [note('tcp', 'from A', 3, 'A')], asks: [ask('1', 'tcp')], aiTerms: [] };
      const remote = [syncFile('B', [note('tcp', 'from B', 5, 'B')], [ask('2', 'tcp')])];

      const first = mergeSnapshot(local, remote, options([['tcp', 5]]));
      const second = mergeSnapshot(local, remote, options([['tcp', 5]]));
      expect(second).toEqual(first);
    });

    // #169の穴(1バッチに同じ端末の複数版が混在するケース)を型ごと塞ぐ(#171)。
    // 各テストは「実行内容 → 想定結果」を先に定めてから実装している。
    describe('1バッチに複数の競合版が混在する場合(#171)', () => {
      it('A2: baseline以下の版とbaseline超えの版が同時に来たら、超えた方を決定として採用する', () => {
        const local: LocalSnapshot = { notes: [note('tcp', 'from A', 3, 'A')], asks: [], aiTerms: [] };
        // 同じ端末Bの2つのblob(解消前t5・解消後t10)が1回のpullに入る状況
        const remote = [syncFile('B', [note('tcp', '解消前のB版', 5, 'B')]), syncFile('B', [note('tcp', 'Bの解消結果', 10, 'B')])];

        const result = mergeSnapshot(local, remote, options([['tcp', 5]]));

        expect(result.notes[0].body).toBe('Bの解消結果');
        expect(result.peerDecisions).toHaveLength(1);
        expect(result.conflicts).toEqual([]);
      });

      it('A3: 競合版が2つともbaseline以下なら自版を保持し、競合相手は新しい方になる', () => {
        const local: LocalSnapshot = { notes: [note('tcp', 'from A', 3, 'A')], asks: [], aiTerms: [] };
        const remote = [syncFile('B', [note('tcp', 'B版(古)', 4, 'B')]), syncFile('B', [note('tcp', 'B版(新)', 6, 'B')])];

        const result = mergeSnapshot(local, remote, options([['tcp', 6]]));

        expect(result.notes[0].body).toBe('from A');
        expect(result.conflicts).toHaveLength(1);
        expect(result.conflicts[0].remote.body).toBe('B版(新)'); // 古い方を掴まない(#169の再発防止)
        expect(result.peerDecisions).toEqual([]);
      });

      it('A1: PCモード(holdLocal無し)でも競合スナップショットは最も新しい競合版になる', () => {
        const local: LocalSnapshot = { notes: [note('tcp', 'from A', 3, 'A')], asks: [], aiTerms: [] };
        const remote = [syncFile('B', [note('tcp', 'B版(古)', 4, 'B')]), syncFile('B', [note('tcp', 'B版(新)', 6, 'B')])];

        const result = mergeSnapshot(local, remote);

        expect(result.notes[0].body).toBe('B版(新)'); // newest-winsは従来どおり
        expect(result.conflicts[0].remote.body).toBe('B版(新)');
      });

      it('A4: 3端末(別peer)の競合版が混在しても、最も新しい版が競合相手になる', () => {
        const local: LocalSnapshot = { notes: [note('tcp', 'from A', 3, 'A')], asks: [], aiTerms: [] };
        const remote = [syncFile('B', [note('tcp', 'B版', 4, 'B')]), syncFile('C', [note('tcp', 'C版', 7, 'C')])];

        const result = mergeSnapshot(local, remote);

        expect(result.conflicts).toHaveLength(1);
        expect(result.conflicts[0].remote.body).toBe('C版');
      });
    });

    describe('境界とtombstone(#171)', () => {
      it('A5: 相手のtombstone(削除)はupdatedAtが新しければ採用される', () => {
        const term = (deletedAt: number | null, updatedAt: number) => ({
          id: 'tcp',
          term: 'TCP',
          readings: ['ティーシーピー'],
          summary: null,
          field: 'ネットワーク' as const,
          tags: [],
          searchKey: 'tcp',
          readingKeys: ['ていしいひい'],
          origin: 'ai' as const,
          createdAt: 1,
          updatedAt,
          deletedAt,
        });
        const local: LocalSnapshot = { notes: [], asks: [], aiTerms: [term(null, 1)] };
        const remote: SyncFile[] = [{ syncSchemaVersion: 1, deviceId: 'B', writtenAt: 1, notes: [], asks: [], aiTerms: [term(500, 5)] }];

        const result = mergeSnapshot(local, remote);

        expect(result.terms).toHaveLength(1);
        expect(result.terms[0].deletedAt).toBe(500); // 削除が伝播する
      });

      it('A5b: 自分の方が新しければ相手のtombstoneでは削除されない(LWW)', () => {
        const base = {
          id: 'tcp',
          term: 'TCP',
          readings: ['ティーシーピー'],
          summary: null,
          field: 'ネットワーク' as const,
          tags: [],
          searchKey: 'tcp',
          readingKeys: ['ていしいひい'],
          origin: 'ai' as const,
          createdAt: 1,
        };
        const local: LocalSnapshot = { notes: [], asks: [], aiTerms: [{ ...base, updatedAt: 9, deletedAt: null }] };
        const remote: SyncFile[] = [
          { syncSchemaVersion: 1, deviceId: 'B', writtenAt: 1, notes: [], asks: [], aiTerms: [{ ...base, updatedAt: 5, deletedAt: 500 }] },
        ];

        expect(mergeSnapshot(local, remote).terms[0].deletedAt).toBeNull();
      });

      it('A6: localに無くremoteだけにある語はそのまま採用し、競合にしない', () => {
        const local: LocalSnapshot = { notes: [], asks: [], aiTerms: [] };
        const remote = [syncFile('B', [note('new-term', '相手だけが持つノート', 5, 'B')])];

        const result = mergeSnapshot(local, remote, options());

        expect(result.notes[0].body).toBe('相手だけが持つノート');
        expect(result.conflicts).toEqual([]);
        expect(result.peerDecisions).toEqual([]);
      });

      it('A7: diagramsだけが違う場合も競合として扱う(isSameContentはdiagramsも見る)', () => {
        const withDiagram = (body: string, diagrams: string[], updatedAt: number, by: string): NoteRecord => ({
          termId: 'tcp',
          body,
          diagrams,
          updatedAt,
          lastEditedBy: by,
          noteHistory: [],
        });
        const local: LocalSnapshot = { notes: [withDiagram('同じ本文', ['graph TD;A-->B;'], 3, 'A')], asks: [], aiTerms: [] };
        const remote: SyncFile[] = [
          { syncSchemaVersion: 1, deviceId: 'B', writtenAt: 1, notes: [withDiagram('同じ本文', ['graph TD;X-->Y;'], 5, 'B')], asks: [], aiTerms: [] },
        ];

        expect(mergeSnapshot(local, remote).conflicts).toHaveLength(1);
      });

      it('A8: 本文もdiagramsも同一なら競合にしない(タイムスタンプだけ違う)', () => {
        const same = (updatedAt: number, by: string): NoteRecord => ({
          termId: 'tcp',
          body: '同じ本文',
          diagrams: ['graph TD;A-->B;'],
          updatedAt,
          lastEditedBy: by,
          noteHistory: [],
        });
        const local: LocalSnapshot = { notes: [same(3, 'A')], asks: [], aiTerms: [] };
        const remote: SyncFile[] = [{ syncSchemaVersion: 1, deviceId: 'B', writtenAt: 1, notes: [same(5, 'B')], asks: [], aiTerms: [] }];

        expect(mergeSnapshot(local, remote).conflicts).toEqual([]);
      });

      it('A6b: remoteに無くlocalだけにある語はそのまま残る', () => {
        const local: LocalSnapshot = { notes: [note('only-local', '自分だけのノート', 5, 'A')], asks: [], aiTerms: [] };
        const remote = [syncFile('B', [])];

        const result = mergeSnapshot(local, remote, options());

        expect(result.notes).toHaveLength(1);
        expect(result.notes[0].body).toBe('自分だけのノート');
      });
    });
  });
});
