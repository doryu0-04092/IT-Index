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
});
