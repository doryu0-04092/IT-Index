import { describe, expect, it } from 'vitest';
import { parseSyncFile } from './validateSyncFile';

function validFile() {
  return {
    syncSchemaVersion: 1,
    deviceId: 'device-A',
    writtenAt: 1,
    notes: [{ termId: 'tcp/ip', body: '説明', diagrams: [], updatedAt: 1, lastEditedBy: 'device-A', noteHistory: [] }],
    asks: [{ id: '1', termId: 'tcp/ip', sessionId: 's1', at: 1, deviceId: 'device-A' }],
    aiTerms: [
      {
        id: 'mtu',
        term: 'MTU',
        readings: ['エムティーユー'],
        summary: null,
        field: 'ネットワーク',
        tags: [],
        searchKey: 'mtu',
        readingKeys: ['えむてぃーゆー'],
        origin: 'ai',
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
      },
    ],
  };
}

describe('parseSyncFile', () => {
  it('accepts a well-formed sync file', () => {
    const result = parseSyncFile(validFile());
    expect(result.ok).toBe(true);
  });

  it('accepts empty arrays (a device with no local changes)', () => {
    const result = parseSyncFile({ syncSchemaVersion: 1, deviceId: 'device-A', writtenAt: 1, notes: [], asks: [], aiTerms: [] });
    expect(result.ok).toBe(true);
  });

  it('rejects unknown syncSchemaVersion', () => {
    const result = parseSyncFile({ ...validFile(), syncSchemaVersion: 999 });
    expect(result.ok).toBe(false);
  });

  it('rejects a malformed note (missing lastEditedBy)', () => {
    const file = validFile();
    // @ts-expect-error 意図的に壊す
    delete file.notes[0].lastEditedBy;
    const result = parseSyncFile(file);
    expect(result.ok).toBe(false);
  });

  it('rejects an aiTerm with origin other than "ai"', () => {
    const file = validFile();
    file.aiTerms[0].origin = 'seed';
    const result = parseSyncFile(file);
    expect(result.ok).toBe(false);
  });

  // 回帰: ローカル検索の確定（asksRepo.addSearchConfirm）は sessionId を持たない。
  // ここで null を弾いていたため、検索結果から用語詳細を一度でも開いた端末が送る同期ファイルは
  // 必ず検証に落ち、ファイルごと読み飛ばされて連携が何も取り込めなくなっていた。
  it('accepts an ask without a sessionId (local search confirmation)', () => {
    const file = validFile();
    file.asks[0].sessionId = null as unknown as string;
    expect(parseSyncFile(file).ok).toBe(true);
  });

  // 回帰: 削除（tombstone）だけは origin を問わず受け入れる。内蔵シードの語を削除した場合も
  // その削除を相手へ伝える必要があるため（送らないと相手の削除前レコードがマージで戻ってくる）。
  it('accepts a deleted seed term so that deletions propagate', () => {
    const file = validFile();
    file.aiTerms[0].origin = 'seed';
    file.aiTerms[0].deletedAt = 123 as unknown as null;
    expect(parseSyncFile(file).ok).toBe(true);
  });

  it('accepts a null summary on aiTerms (AI-registered terms have no summary)', () => {
    const result = parseSyncFile(validFile());
    expect(result.ok).toBe(true);
  });

  it('rejects garbage input', () => {
    expect(parseSyncFile('not an object').ok).toBe(false);
    expect(parseSyncFile(null).ok).toBe(false);
    expect(parseSyncFile(42).ok).toBe(false);
  });

  // #171: 検証の残りの分岐(必須メタ情報の欠落・配列でないケース)。
  // ここが通ってしまうと壊れたblobを取り込んでローカルデータを壊しうるため、
  // 「1つでも欠けたら必ずreasonつきで落ちる」ことを固定する。
  describe('必須メタ情報の欠落(#171)', () => {
    it('deviceIdが無い/空文字なら落ちる', () => {
      expect(parseSyncFile({ ...validFile(), deviceId: undefined })).toMatchObject({ ok: false, reason: 'deviceId がありません' });
      expect(parseSyncFile({ ...validFile(), deviceId: '' })).toMatchObject({ ok: false, reason: 'deviceId がありません' });
    });

    it('writtenAtが数値でなければ落ちる', () => {
      expect(parseSyncFile({ ...validFile(), writtenAt: '2026-08-20' })).toMatchObject({
        ok: false,
        reason: 'writtenAt がありません',
      });
    });

    it('notes/asks/aiTermsが配列でなければ落ちる', () => {
      expect(parseSyncFile({ ...validFile(), notes: null })).toMatchObject({ ok: false, reason: 'notes の形式が不正です' });
      expect(parseSyncFile({ ...validFile(), asks: 'x' })).toMatchObject({ ok: false, reason: 'asks の形式が不正です' });
      expect(parseSyncFile({ ...validFile(), aiTerms: {} })).toMatchObject({ ok: false, reason: 'aiTerms の形式が不正です' });
    });

    it('askの必須項目が欠けていれば落ちる', () => {
      const file = validFile();
      expect(parseSyncFile({ ...file, asks: [{ ...file.asks[0], at: 'いつか' }] })).toMatchObject({
        ok: false,
        reason: 'asks の形式が不正です',
      });
    });

    it('aiTermのsummaryが文字列ならそのまま通る(シード由来の削除語など)', () => {
      const file = validFile();
      expect(parseSyncFile({ ...file, aiTerms: [{ ...file.aiTerms[0], summary: '初期説明つき' }] }).ok).toBe(true);
    });

    it('aiTermのsummaryが文字列でもnullでもなければ落ちる', () => {
      const file = validFile();
      expect(parseSyncFile({ ...file, aiTerms: [{ ...file.aiTerms[0], summary: 42 }] })).toMatchObject({
        ok: false,
        reason: 'aiTerms の形式が不正です',
      });
    });

    it('aiTermのidが文字列でなければ落ちる(先頭の項目チェック)', () => {
      const file = validFile();
      expect(parseSyncFile({ ...file, aiTerms: [{ ...file.aiTerms[0], id: 42 }] })).toMatchObject({
        ok: false,
        reason: 'aiTerms の形式が不正です',
      });
    });

    it('配列の中身がオブジェクトでない(null・文字列・数値)場合も落ちる', () => {
      const file = validFile();
      expect(parseSyncFile({ ...file, notes: [null] })).toMatchObject({ ok: false, reason: 'notes の形式が不正です' });
      expect(parseSyncFile({ ...file, asks: ['文字列'] })).toMatchObject({ ok: false, reason: 'asks の形式が不正です' });
      expect(parseSyncFile({ ...file, aiTerms: [42] })).toMatchObject({ ok: false, reason: 'aiTerms の形式が不正です' });
    });

    it('aiTermのfieldが一覧に無ければ落ちる', () => {
      const file = validFile();
      expect(parseSyncFile({ ...file, aiTerms: [{ ...file.aiTerms[0], field: '架空の分野' }] })).toMatchObject({
        ok: false,
        reason: 'aiTerms の形式が不正です',
      });
    });
  });
});
