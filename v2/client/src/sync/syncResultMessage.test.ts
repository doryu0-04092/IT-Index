import { describe, expect, it } from 'vitest';
import type { SyncRunResult } from './syncEngine';
import { formatSyncSummary, formatSyncToast } from './syncResultMessage';

/**
 * 文言そのものを固定する(#216)。パネルとトーストが別々に組んでいたために
 * 片方だけ #202 の変更が当たらなかったので、正本をここで押さえる。
 */
function result(overrides: Partial<SyncRunResult> = {}): SyncRunResult {
  return {
    syncEventId: 'event-1',
    receivedBlobs: 0,
    skippedBlobs: 0,
    undecryptableBlobs: 0,
    changedTerms: 0,
    conflictCount: 0,
    adoptedDecisions: 0,
    ...overrides,
  };
}

describe('formatSyncSummary', () => {
  it('変わった語が無ければ、そう述べる', () => {
    expect(formatSyncSummary(result())).toBe('変わった内容はありません');
  });

  it('変わった語数を出す', () => {
    expect(formatSyncSummary(result({ changedTerms: 3 }))).toBe('3語 変わりました');
  });

  /**
   * blobを受信していても中身が同じなら「変わっていない」と述べる(#202)。
   * 端末は毎回全量スナップショットを送るため、受信件数は利用者の知りたい情報にならない。
   */
  it('受信blobがあっても、変わった語が0なら件数を出さない', () => {
    expect(formatSyncSummary(result({ receivedBlobs: 5 }))).toBe('変わった内容はありません');
  });

  it('競合・統一・復号不可・読み取り不可を、あるものだけ後ろに繋げる', () => {
    expect(formatSyncSummary(result({ changedTerms: 2, conflictCount: 1 }))).toBe('2語 変わりました・競合1件');
    expect(formatSyncSummary(result({ adoptedDecisions: 4 }))).toBe(
      '変わった内容はありません・パソコン側の解消結果に4件統一',
    );
    expect(formatSyncSummary(result({ undecryptableBlobs: 2 }))).toBe(
      '変わった内容はありません・鍵が合わず読めなかった分2件',
    );
    expect(formatSyncSummary(result({ skippedBlobs: 1 }))).toBe(
      '変わった内容はありません・読めなかったデータ1件',
    );
  });

  it('全部そろった場合の並び順を固定する', () => {
    expect(
      formatSyncSummary(
        result({ changedTerms: 7, conflictCount: 2, adoptedDecisions: 3, undecryptableBlobs: 1, skippedBlobs: 4 }),
      ),
    ).toBe('7語 変わりました・競合2件・パソコン側の解消結果に3件統一・鍵が合わず読めなかった分1件・読めなかったデータ4件');
  });
});

describe('formatSyncToast', () => {
  /** 括弧で囲むと「同期しました(変わった内容はありません)。」となり不自然(本人指定) */
  it('パネルと同じ文言に「同期しました。」を前置しただけの形にする', () => {
    const r = result({ changedTerms: 1 });
    expect(formatSyncToast(r)).toBe(`同期しました。${formatSyncSummary(r)}`);
    expect(formatSyncToast(result())).toBe('同期しました。変わった内容はありません');
  });

  it('受信blobの件数は出さない(#202で画面から外した数値)', () => {
    expect(formatSyncToast(result({ receivedBlobs: 9 }))).not.toContain('受信');
  });
});
