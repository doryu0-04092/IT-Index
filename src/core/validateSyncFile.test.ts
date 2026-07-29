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
