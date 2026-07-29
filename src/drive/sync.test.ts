import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ItIndexDB } from '../db';
import { createAsksRepository } from '../repositories/asks';
import { createNotesRepository } from '../repositories/notes';
import { buildTermRecord, createTermsRepository, makeTermId } from '../repositories/terms';
import { syncFileName } from '../sync/syncFile';
import { runSync } from './sync';
import { createFakeDriveFilesClient } from './testSupport';

describe('runSync', () => {
  let db: ItIndexDB;

  beforeEach(() => {
    db = new ItIndexDB(`test-sync-${crypto.randomUUID()}`);
  });

  afterEach(async () => {
    await db.delete();
  });

  it("uploads only this device's own notes/asks on first sync (no remote files yet)", async () => {
    const notesRepo = createNotesRepository(db);
    const asksRepo = createAsksRepository(db);
    const termsRepo = createTermsRepository(db);
    const deviceId = 'device-A';
    const now = Date.now();

    await notesRepo.applyCommit('tcp/ip', '説明', [], deviceId, now);
    await asksRepo.addMany([{ termId: 'tcp/ip', sessionId: 's1', at: now, deviceId }]);

    const drive = createFakeDriveFilesClient();
    const result = await runSync({ deviceId, driveFiles: drive, notesRepo, asksRepo, termsRepo });

    expect(result.skippedFiles).toEqual([]);
    expect(result.mergedNoteCount).toBe(1);

    const uploaded = JSON.parse(drive.filesByName()[syncFileName(deviceId)]);
    expect(uploaded.notes).toHaveLength(1);
    expect(uploaded.notes[0].termId).toBe('tcp/ip');
    expect(uploaded.asks).toHaveLength(1);
  });

  it('pulls in a note from another device and does not re-upload it as our own', async () => {
    const notesRepo = createNotesRepository(db);
    const asksRepo = createAsksRepository(db);
    const termsRepo = createTermsRepository(db);
    const deviceId = 'device-A';

    const remoteFile = {
      syncSchemaVersion: 1,
      deviceId: 'device-B',
      writtenAt: 1,
      notes: [{ termId: 'udp', body: '別端末の説明', diagrams: [], updatedAt: 1, lastEditedBy: 'device-B', noteHistory: [] }],
      asks: [{ id: 'ask-1', termId: 'udp', sessionId: 's-b', at: 1, deviceId: 'device-B' }],
      aiTerms: [],
    };
    const drive = createFakeDriveFilesClient({ 'device-B.json': JSON.stringify(remoteFile) });

    const result = await runSync({ deviceId, driveFiles: drive, notesRepo, asksRepo, termsRepo });

    expect(result.mergedNoteCount).toBe(1);
    expect((await notesRepo.getByTermId('udp'))?.body).toBe('別端末の説明'); // ローカルに取り込まれている

    const uploaded = JSON.parse(drive.filesByName()[syncFileName(deviceId)]);
    expect(uploaded.notes).toEqual([]); // 自分の分ではないので自分のファイルには含めない
  });

  it('skips a malformed remote file but still processes the others', async () => {
    const notesRepo = createNotesRepository(db);
    const asksRepo = createAsksRepository(db);
    const termsRepo = createTermsRepository(db);

    const goodFile = {
      syncSchemaVersion: 1,
      deviceId: 'device-B',
      writtenAt: 1,
      notes: [{ termId: 'udp', body: '説明', diagrams: [], updatedAt: 1, lastEditedBy: 'device-B', noteHistory: [] }],
      asks: [],
      aiTerms: [],
    };
    const drive = createFakeDriveFilesClient({
      'device-B.json': JSON.stringify(goodFile),
      'device-C.json': '{ this is not valid json',
      'device-D.json': JSON.stringify({ syncSchemaVersion: 999, deviceId: 'device-D', writtenAt: 1, notes: [], asks: [], aiTerms: [] }),
    });

    const result = await runSync({ deviceId: 'device-A', driveFiles: drive, notesRepo, asksRepo, termsRepo });

    expect(result.skippedFiles.sort()).toEqual(['device-C.json', 'device-D.json']);
    expect((await notesRepo.getByTermId('udp'))?.body).toBe('説明');
  });

  it('reports a conflict when both this device and a remote device updated the same term', async () => {
    const notesRepo = createNotesRepository(db);
    const asksRepo = createAsksRepository(db);
    const termsRepo = createTermsRepository(db);
    const deviceId = 'device-A';

    await notesRepo.applyCommit('tcp/ip', 'Aの説明', [], deviceId, 5);

    const remoteFile = {
      syncSchemaVersion: 1,
      deviceId: 'device-B',
      writtenAt: 1,
      notes: [{ termId: 'tcp/ip', body: 'Bの説明', diagrams: [], updatedAt: 3, lastEditedBy: 'device-B', noteHistory: [] }],
      asks: [],
      aiTerms: [],
    };
    const drive = createFakeDriveFilesClient({ 'device-B.json': JSON.stringify(remoteFile) });

    const result = await runSync({ deviceId, driveFiles: drive, notesRepo, asksRepo, termsRepo });

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].termId).toBe('tcp/ip');
    // 決定的マージは新しい方（Aの説明・updatedAt=5）を採用しつつ、鍵が無くても機能する
    expect((await notesRepo.getByTermId('tcp/ip'))?.body).toBe('Aの説明');
  });

  it('overwrites the existing own file on the second sync instead of creating a duplicate', async () => {
    const notesRepo = createNotesRepository(db);
    const asksRepo = createAsksRepository(db);
    const termsRepo = createTermsRepository(db);
    const deviceId = 'device-A';

    await notesRepo.applyCommit('tcp/ip', '1回目', [], deviceId, 1);
    const drive = createFakeDriveFilesClient();
    await runSync({ deviceId, driveFiles: drive, notesRepo, asksRepo, termsRepo });

    await notesRepo.applyCommit('udp', '2回目', [], deviceId, 2);
    await runSync({ deviceId, driveFiles: drive, notesRepo, asksRepo, termsRepo });

    const filesAfter = await drive.list();
    expect(filesAfter.filter((f) => f.name === syncFileName(deviceId))).toHaveLength(1); // 重複作成されていない

    const uploaded = JSON.parse(drive.filesByName()[syncFileName(deviceId)]);
    expect(uploaded.notes).toHaveLength(2);
  });

  it('includes ai-origin terms in the outbound file (aiTerms exception to sync exclusion)', async () => {
    const notesRepo = createNotesRepository(db);
    const asksRepo = createAsksRepository(db);
    const termsRepo = createTermsRepository(db);
    const deviceId = 'device-A';
    const now = Date.now();

    const aiTerm = buildTermRecord({ term: 'MTU', readings: ['エムティーユー'], summary: null, field: 'ネットワーク', origin: 'ai', now });
    await termsRepo.upsertFromAi(aiTerm);

    const drive = createFakeDriveFilesClient();
    await runSync({ deviceId, driveFiles: drive, notesRepo, asksRepo, termsRepo });

    const uploaded = JSON.parse(drive.filesByName()[syncFileName(deviceId)]);
    expect(uploaded.aiTerms.map((t: { id: string }) => t.id)).toEqual([makeTermId('MTU')]);
  });
});
