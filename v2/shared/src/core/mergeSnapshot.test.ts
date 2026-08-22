import { describe, expect, it } from 'vitest';
import type { AskRecord, NoteRecord } from '../types';
import { mergeSnapshot, type LocalSnapshot, type SyncFile } from './mergeSnapshot';

function note(termId: string, body: string, updatedAt: number, lastEditedBy: string): NoteRecord {
  // resolvedAt: null = 通常の編集(解消の結果ではない)。#234
  return { termId, body, diagrams: [], updatedAt, lastEditedBy, resolvedAt: null, noteHistory: [] };
}

function ask(id: string, termId: string): AskRecord {
  return { id, termId, sessionId: 's', at: 1, deviceId: 'd', source: 'ai' };
}

function syncFile(deviceId: string, notes: NoteRecord[], asks: AskRecord[] = []): SyncFile {
  return { syncSchemaVersion: 1, deviceId, writtenAt: 1, notes, asks, aiTerms: [] };
}

describe('mergeSnapshot', () => {
  /**
   * #234で前提を変更した。元は「A版 vs B版」で newest-wins を確かめていたが、それは
   * **競合そのもの**で、いまは自分の版を保持する。newest-winsが効くのは競合でない時
   * (片方しか編集していない=lastEditedByが同じ)なので、そちらで確かめる。
   */
  it('競合でなければ updatedAt が新しい方を採用する', () => {
    // Bは受け取っただけ(lastEditedBy=A)。競合ではないので新しい方が入る
    const local: LocalSnapshot = { notes: [note('tcp', 'old', 1, 'A')], asks: [], aiTerms: [] };
    const remote = [syncFile('B', [note('tcp', 'new', 2, 'A')])];

    const result = mergeSnapshot(local, remote);
    expect(result.notes[0].body).toBe('new');
    expect(result.conflicts).toEqual([]);
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
      resolvedAt: null,
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
      resolvedAt: null,
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
      // #234: 「解消の結果」であることを resolvedAt で示す。単なる追加編集は採用されない
      const remote = [syncFile('B', [{ ...note('tcp', 'PCの解消結果', 10, 'B'), resolvedAt: 10 }])];

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
        const remote = [
          syncFile('B', [note('tcp', '解消前のB版', 5, 'B')]),
          syncFile('B', [{ ...note('tcp', 'Bの解消結果', 10, 'B'), resolvedAt: 10 }]),
        ];

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

      /**
       * #234で期待値を変更した。競合中は自分の版を保持するので notes は 'from A' のまま。
       * このテストの本来の意図(#169: 競合スナップショットが古い版にならない)は
       * conflicts 側で引き続き固定する。
       */
      it('A1: 競合スナップショットは最も新しい競合版になる(自分の版は保持する)', () => {
        const local: LocalSnapshot = { notes: [note('tcp', 'from A', 3, 'A')], asks: [], aiTerms: [] };
        const remote = [syncFile('B', [note('tcp', 'B版(古)', 4, 'B')]), syncFile('B', [note('tcp', 'B版(新)', 6, 'B')])];

        const result = mergeSnapshot(local, remote);

        expect(result.notes[0].body).toBe('from A'); // 解消するまで置き換わらない(#234)
        expect(result.conflicts[0].remote.body).toBe('B版(新)');
      });

      /**
       * #224 で期待値を変更した。元は「conflicts は1件」を固定していたが、それは
       * **3台目が記録されない**という欠陥そのものだった(実機で「3端末で編集しても2行しか出ない」
       * として現れた)。このテストの本来の意図は #169 由来の**古い版を掴まないこと**なので、
       * そちらは「先頭(最も新しい競合版)が C版であること」で引き続き固定する。
       */
      it('A4: 3端末(別peer)の競合版が混在したら相手ごとに積み、先頭は最も新しい版になる', () => {
        const local: LocalSnapshot = { notes: [note('tcp', 'from A', 3, 'A')], asks: [], aiTerms: [] };
        const remote = [syncFile('B', [note('tcp', 'B版', 4, 'B')]), syncFile('C', [note('tcp', 'C版', 7, 'C')])];

        const result = mergeSnapshot(local, remote);

        expect(result.conflicts).toHaveLength(2);
        expect(result.conflicts[0].remote.body).toBe('C版'); // 古い方を掴まない(#169の再発防止)
        expect(result.conflicts.map((c) => c.remote.lastEditedBy).sort()).toEqual(['B', 'C']);
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
          resolvedAt: null,
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
          resolvedAt: null,
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

  /**
   * 3端末での競合(#224)。
   *
   * 従来は「最も新しい競合版」1台だけを conflicts に積んでいたため、3台目以降が
   * どこにも記録されず、画面には常に「この端末＋相手1台」の2行しか出せなかった
   * (#203 は表示のまとめ方だけを直したが、まとめる材料が1件しか無かった)。
   *
   * **notes の勝者は1件のまま**(1語1note)で、conflicts だけを相手ごとに積む。
   */
  describe('複数端末との競合(#224)', () => {
    it('3端末がそれぞれ独自に編集したら、競合を相手ごとに積む', () => {
      const local: LocalSnapshot = { notes: [note('tcp', 'Aの版', 5, 'A')], asks: [], aiTerms: [] };
      const remote = [syncFile('B', [note('tcp', 'Bの版', 3, 'B')]), syncFile('C', [note('tcp', 'Cの版', 4, 'C')])];

      const result = mergeSnapshot(local, remote);

      expect(result.conflicts).toHaveLength(2);
      expect(result.conflicts.map((c) => c.remote.lastEditedBy).sort()).toEqual(['B', 'C']);
    });

    it('競合が複数でも note は1件だけで、内容は自分の版のまま(#234)', () => {
      const local: LocalSnapshot = { notes: [note('tcp', 'Aの版', 5, 'A')], asks: [], aiTerms: [] };
      const remote = [syncFile('B', [note('tcp', 'Bの版', 9, 'B')]), syncFile('C', [note('tcp', 'Cの版', 4, 'C')])];

      const result = mergeSnapshot(local, remote);

      expect(result.notes.filter((n) => n.termId === 'tcp')).toHaveLength(1);
      // 相手の方が新しくても、解消するまで自分の版のまま
      expect(result.notes.find((n) => n.termId === 'tcp')?.body).toBe('Aの版');
    });

    /** 競合として積むのは isRealConflict を満たす相手だけ。受け取っただけの端末は数えない */
    it('片方が「受け取っただけ」なら、その端末は競合に数えない', () => {
      const local: LocalSnapshot = { notes: [note('tcp', 'Aの新しい版', 5, 'A')], asks: [], aiTerms: [] };
      const remote = [
        syncFile('B', [note('tcp', 'Aの古い版', 3, 'A')]), // Bは受け取っただけ(lastEditedBy=A)
        syncFile('C', [note('tcp', 'Cの版', 4, 'C')]),
      ];

      const result = mergeSnapshot(local, remote);

      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].remote.lastEditedBy).toBe('C');
    });

    /** 同じ端末の blob が1回のpullに複数入っても、その端末ぶんは1件に畳む(#169と同じ理由) */
    it('同じ端末の版が複数届いても、その端末の競合は最も新しい1件に畳む', () => {
      const local: LocalSnapshot = { notes: [note('tcp', 'Aの版', 5, 'A')], asks: [], aiTerms: [] };
      const remote = [
        syncFile('B', [note('tcp', 'Bの古い版', 2, 'B')]),
        syncFile('B', [note('tcp', 'Bの新しい版', 8, 'B')]),
      ];

      const result = mergeSnapshot(local, remote);

      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].remote.body).toBe('Bの新しい版');
    });

    /**
     * holdLocalOnConflict(Androidネイティブ)では、PCの決定を採用する判定は従来どおり
     * **語単位で1つ**。決定を採用しなかった場合に、残りの相手ぶんの競合が記録される。
     */
    it('holdLocalOnConflict でも、採用しなかった相手ぶんの競合を記録する', () => {
      const local: LocalSnapshot = { notes: [note('tcp', 'Aの版', 5, 'A')], asks: [], aiTerms: [] };
      const remote = [syncFile('B', [note('tcp', 'Bの版', 3, 'B')]), syncFile('C', [note('tcp', 'Cの版', 4, 'C')])];

      const result = mergeSnapshot(local, remote, {
        openConflictBaselines: new Map(), // baselineが無い=決定とみなさない
      });

      expect(result.peerDecisions).toHaveLength(0);
      expect(result.notes.find((n) => n.termId === 'tcp')?.body).toBe('Aの版'); // 自分の版を保持
      expect(result.conflicts.map((c) => c.remote.lastEditedBy).sort()).toEqual(['B', 'C']);
    });
  });

  /**
   * **競合の解消をして初めて、その内容が他の端末でも共有される(#234)。**
   *
   * 以前は競合していても newest-wins で内容を確定していたため、**利用者が何もしていないのに
   * 自分の書いた本文が相手の版へ置き換わっていた**(しかも noteHistory にも残らない)。
   * 実測で確認した上で方針を変えた。
   *
   * 変わるのは**競合と判定された時だけ**。片方でしか編集していない場合は isRealConflict が
   * false なので、今までどおり相手の内容が反映される。
   */
  describe('競合中は自分の版を保持する(#234)', () => {
    it('競合したら、相手の方が新しくても自分の版を保持する', () => {
      const local: LocalSnapshot = { notes: [note('tcp', 'Aの版', 100, 'A')], asks: [], aiTerms: [] };
      const remote = [syncFile('B', [note('tcp', 'Bの版', 200, 'B')])];

      const result = mergeSnapshot(local, remote);

      expect(result.notes[0].body).toBe('Aの版'); // 相手の版で上書きされない
      expect(result.conflicts).toHaveLength(1);
      expect(result.peerDecisions).toEqual([]);
    });

    it('競合していなければ、従来どおり新しい方を採用する(片方しか編集していない場合)', () => {
      // Bは受け取っただけ(lastEditedBy=A)なので競合ではない
      const local: LocalSnapshot = { notes: [note('tcp', 'Aの古い版', 100, 'A')], asks: [], aiTerms: [] };
      const remote = [syncFile('B', [note('tcp', 'Aの新しい版', 200, 'A')])];

      const result = mergeSnapshot(local, remote);

      expect(result.notes[0].body).toBe('Aの新しい版');
      expect(result.conflicts).toEqual([]);
    });

    /** 解消の結果だけが相手へ伝わる。単なる追加編集は「決定」ではない */
    it('相手が解消した版なら採用する', () => {
      const local: LocalSnapshot = { notes: [note('tcp', 'Aの版', 100, 'A')], asks: [], aiTerms: [] };
      const resolved = { ...note('tcp', 'Bが解消した版', 300, 'B'), resolvedAt: 300 };
      const remote = [syncFile('B', [resolved])];

      const result = mergeSnapshot(local, remote, { openConflictBaselines: new Map([['tcp', 200]]) });

      expect(result.notes[0].body).toBe('Bが解消した版');
      expect(result.peerDecisions).toHaveLength(1);
      expect(result.conflicts).toEqual([]);
    });

    it('相手が解消せずに追加編集しただけなら採用しない(自分の版を保持する)', () => {
      const local: LocalSnapshot = { notes: [note('tcp', 'Aの版', 100, 'A')], asks: [], aiTerms: [] };
      // resolvedAt が無い = 解消の結果ではない。updatedAtはbaselineより新しい
      const remote = [syncFile('B', [note('tcp', 'Bが書き足した版', 300, 'B')])];

      const result = mergeSnapshot(local, remote, { openConflictBaselines: new Map([['tcp', 200]]) });

      expect(result.notes[0].body).toBe('Aの版');
      expect(result.peerDecisions).toEqual([]);
      expect(result.conflicts).toHaveLength(1);
    });

    it('解消の版でも、競合検出時に見た版より古ければ採用しない(取りこぼしの巻き戻しを防ぐ)', () => {
      const local: LocalSnapshot = { notes: [note('tcp', 'Aの版', 100, 'A')], asks: [], aiTerms: [] };
      const stale = { ...note('tcp', 'Bの古い解消', 150, 'B'), resolvedAt: 150 };
      const remote = [syncFile('B', [stale])];

      const result = mergeSnapshot(local, remote, { openConflictBaselines: new Map([['tcp', 200]]) });

      expect(result.notes[0].body).toBe('Aの版');
      expect(result.peerDecisions).toEqual([]);
    });
  });

});
