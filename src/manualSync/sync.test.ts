import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ItIndexDB } from '../db';
import { createAsksRepository } from '../repositories/asks';
import { createNoteConflictsRepository } from '../repositories/noteConflicts';
import { createNotesRepository } from '../repositories/notes';
import { buildTermRecord, createTermsRepository, makeTermId } from '../repositories/terms';
import { exportFullSnapshot, exportOwnSyncFile, importSyncFiles } from './sync';

describe('exportOwnSyncFile / importSyncFiles', () => {
  let db: ItIndexDB;

  beforeEach(() => {
    db = new ItIndexDB(`test-manual-sync-${crypto.randomUUID()}`);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('exports only this device own notes/asks, named device-<id>.json', async () => {
    const notesRepo = createNotesRepository(db);
    const asksRepo = createAsksRepository(db);
    const termsRepo = createTermsRepository(db);
    const conflictsRepo = createNoteConflictsRepository(db);
    const deviceId = 'device-A';
    const now = Date.now();

    await notesRepo.applyCommit('tcp/ip', '説明', [], deviceId, now);
    await asksRepo.addMany([{ termId: 'tcp/ip', sessionId: 's1', at: now, deviceId, source: 'ai' }]);

    const exported = await exportOwnSyncFile({ deviceId, notesRepo, asksRepo, termsRepo, conflictsRepo });

    expect(exported.name).toBe('device-device-A.json');
    const parsed = JSON.parse(exported.content);
    expect(parsed.notes).toHaveLength(1);
    expect(parsed.notes[0].termId).toBe('tcp/ip');
    expect(parsed.deviceId).toBe(deviceId);
  });

  it('imports a note from another device exported file into the local DB', async () => {
    const notesRepo = createNotesRepository(db);
    const asksRepo = createAsksRepository(db);
    const termsRepo = createTermsRepository(db);
    const conflictsRepo = createNoteConflictsRepository(db);

    const remoteFile = {
      name: 'device-device-B.json',
      content: JSON.stringify({
        syncSchemaVersion: 1,
        deviceId: 'device-B',
        writtenAt: 1,
        notes: [{ termId: 'udp', body: '別端末の説明', diagrams: [], updatedAt: 1, lastEditedBy: 'device-B', noteHistory: [] }],
        asks: [{ id: 'ask-1', termId: 'udp', sessionId: 's-b', at: 1, deviceId: 'device-B', source: 'ai' }],
        aiTerms: [],
      }),
    };

    const result = await importSyncFiles([remoteFile], { deviceId: 'device-A', notesRepo, asksRepo, termsRepo, conflictsRepo });

    expect(result.receivedDelta.noteTermIds).toEqual(['udp']);
    expect(result.peerDeviceIds).toEqual(['device-B']);
    expect(result.skippedFiles).toEqual([]);
    expect((await notesRepo.getByTermId('udp'))?.body).toBe('別端末の説明');
  });

  it('skips a malformed file but processes the others', async () => {
    const notesRepo = createNotesRepository(db);
    const asksRepo = createAsksRepository(db);
    const termsRepo = createTermsRepository(db);
    const conflictsRepo = createNoteConflictsRepository(db);

    const goodFile = {
      name: 'device-device-B.json',
      content: JSON.stringify({
        syncSchemaVersion: 1,
        deviceId: 'device-B',
        writtenAt: 1,
        notes: [{ termId: 'udp', body: '説明', diagrams: [], updatedAt: 1, lastEditedBy: 'device-B', noteHistory: [] }],
        asks: [],
        aiTerms: [],
      }),
    };
    const brokenFile = { name: 'broken.json', content: '{ not valid json' };

    const result = await importSyncFiles([goodFile, brokenFile], {
      deviceId: 'device-A',
      notesRepo,
      asksRepo,
      termsRepo,
      conflictsRepo,
    });

    expect(result.skippedFiles).toEqual(['broken.json']);
    expect((await notesRepo.getByTermId('udp'))?.body).toBe('説明');
  });

  it('reports a conflict when both this device and the imported file updated the same term, and persists it', async () => {
    const notesRepo = createNotesRepository(db);
    const asksRepo = createAsksRepository(db);
    const termsRepo = createTermsRepository(db);
    const conflictsRepo = createNoteConflictsRepository(db);
    const deviceId = 'device-A';

    await notesRepo.applyCommit('tcp/ip', 'Aの説明', [], deviceId, 5);

    const remoteFile = {
      name: 'device-device-B.json',
      content: JSON.stringify({
        syncSchemaVersion: 1,
        deviceId: 'device-B',
        writtenAt: 1,
        notes: [{ termId: 'tcp/ip', body: 'Bの説明', diagrams: [], updatedAt: 3, lastEditedBy: 'device-B', noteHistory: [] }],
        asks: [],
        aiTerms: [],
      }),
    };

    const result = await importSyncFiles([remoteFile], { deviceId, notesRepo, asksRepo, termsRepo, conflictsRepo });

    expect(result.conflicts).toHaveLength(1);
    expect((await notesRepo.getByTermId('tcp/ip'))?.body).toBe('Aの説明'); // 決定的マージは新しい方を採用

    // 2026-08-07: 検出した瞬間にnoteConflictsへ保存され、選ばずに画面を離れても後から見返せる
    const persisted = await conflictsRepo.getAllOrdered();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].termId).toBe('tcp/ip');
    expect(persisted[0].resolution).toBeNull();
  });

  it('does not re-report the same conflict after it was resolved via applyConflictResolution', async () => {
    const notesRepo = createNotesRepository(db);
    const asksRepo = createAsksRepository(db);
    const termsRepo = createTermsRepository(db);
    const conflictsRepo = createNoteConflictsRepository(db);
    const deviceId = 'device-A';

    await notesRepo.applyCommit('tcp/ip', 'Aの説明', [], deviceId, 5);
    const remoteFile = {
      name: 'device-device-B.json',
      content: JSON.stringify({
        syncSchemaVersion: 1,
        deviceId: 'device-B',
        writtenAt: 1,
        notes: [{ termId: 'tcp/ip', body: 'Bの説明', diagrams: [], updatedAt: 3, lastEditedBy: 'device-B', noteHistory: [] }],
        asks: [],
        aiTerms: [],
      }),
    };

    const first = await importSyncFiles([remoteFile], { deviceId, notesRepo, asksRepo, termsRepo, conflictsRepo });
    expect(first.conflicts).toHaveLength(1);

    // 「この端末を採用」を選んだ場合。不採用側（Bの説明）を履歴に積む必要がある
    await notesRepo.applyConflictResolution('tcp/ip', 'Aの説明', [], deviceId, 6, { body: 'Bの説明', diagrams: [] });

    // 同じ相手ファイルをもう一度取り込んでも、同じ2版なので再競合しない
    const second = await importSyncFiles([remoteFile], { deviceId, notesRepo, asksRepo, termsRepo, conflictsRepo });
    expect(second.conflicts).toHaveLength(0);
  });

  it('a full export -> import round trip carries ai-origin terms across', async () => {
    const notesRepo = createNotesRepository(db);
    const asksRepo = createAsksRepository(db);
    const termsRepo = createTermsRepository(db);
    const conflictsRepo = createNoteConflictsRepository(db);
    const now = Date.now();

    const aiTerm = buildTermRecord({ term: 'MTU', readings: ['エムティーユー'], summary: null, field: 'ネットワーク', origin: 'ai', now });
    await termsRepo.upsertFromAi(aiTerm);

    const exported = await exportOwnSyncFile({ deviceId: 'device-A', notesRepo, asksRepo, termsRepo, conflictsRepo });

    // 別のまっさらな端末に見立てて取り込む
    const otherDb = new ItIndexDB(`test-manual-sync-other-${crypto.randomUUID()}`);
    try {
      const otherNotesRepo = createNotesRepository(otherDb);
      const otherAsksRepo = createAsksRepository(otherDb);
      const otherTermsRepo = createTermsRepository(otherDb);
      const otherConflictsRepo = createNoteConflictsRepository(otherDb);

      await importSyncFiles([exported], {
        deviceId: 'device-B',
        notesRepo: otherNotesRepo,
        asksRepo: otherAsksRepo,
        termsRepo: otherTermsRepo,
        conflictsRepo: otherConflictsRepo,
      });

      expect(await otherTermsRepo.getById(makeTermId('MTU'))).toBeDefined();
    } finally {
      await otherDb.delete();
    }
  });
});

describe('exportFullSnapshot (PC-as-relay scenario for devices without shared-folder access)', () => {
  let pcDb: ItIndexDB;
  let androidDb: ItIndexDB;

  beforeEach(() => {
    pcDb = new ItIndexDB(`test-relay-pc-${crypto.randomUUID()}`);
    androidDb = new ItIndexDB(`test-relay-android-${crypto.randomUUID()}`);
  });

  afterEach(async () => {
    await pcDb.delete();
    await androidDb.delete();
  });

  it('relays data from a third device (already merged into PC) back to Android, which cannot reach the shared folder directly', async () => {
    const pcDeps = {
      deviceId: 'device-PC',
      notesRepo: createNotesRepository(pcDb),
      asksRepo: createAsksRepository(pcDb),
      termsRepo: createTermsRepository(pcDb),
      conflictsRepo: createNoteConflictsRepository(pcDb),
    };
    const androidDeps = {
      deviceId: 'device-Android',
      notesRepo: createNotesRepository(androidDb),
      asksRepo: createAsksRepository(androidDb),
      termsRepo: createTermsRepository(androidDb),
      conflictsRepo: createNoteConflictsRepository(androidDb),
    };

    // 前提: PCは以前、共有フォルダ経由で device-C の分をすでに取り込み済み
    await pcDeps.notesRepo.applyCommit('ip', 'device-Cが書いた説明', [], 'device-C', 1);

    // ① Android: 自分の分をエクスポート
    await androidDeps.notesRepo.applyCommit('tcp/ip', 'Androidで聞いた説明', [], 'device-Android', 2);
    const androidDiff = await exportOwnSyncFile(androidDeps);

    // ② PC: Androidの分を取り込む（通常のマージ）
    const importResult = await importSyncFiles([androidDiff], pcDeps);
    // 取り込み前のPCは既に device-C 分を持っているため、今回新しく増えたのは Android 分のみ
    expect(importResult.receivedDelta.noteTermIds).toEqual(['tcp/ip']);

    // ③ PC: 「知っている全部」をエクスポート（device-C分もAndroid分も両方含む）
    const fullSnapshot = await exportFullSnapshot(pcDeps);
    expect(fullSnapshot.name).toBe('full-device-device-PC.json');
    const parsed = JSON.parse(fullSnapshot.content);
    expect(parsed.notes.map((n: { termId: string }) => n.termId).sort()).toEqual(['ip', 'tcp/ip']);

    // ④ Android: PCから受け取った全部を取り込む（上書きではなく通常のマージ）
    await importSyncFiles([fullSnapshot], androidDeps);

    // Androidは device-C の分（自分が直接やり取りしたことのない端末の分）まで手に入る
    expect((await androidDeps.notesRepo.getByTermId('ip'))?.body).toBe('device-Cが書いた説明');
    // 自分自身の分もそのまま残っている（上書きで消えていない）
    expect((await androidDeps.notesRepo.getByTermId('tcp/ip'))?.body).toBe('Androidで聞いた説明');
  });

  it('does not lose new local edits made on the receiving device between steps (why merge beats overwrite)', async () => {
    const pcDeps = {
      deviceId: 'device-PC',
      notesRepo: createNotesRepository(pcDb),
      asksRepo: createAsksRepository(pcDb),
      termsRepo: createTermsRepository(pcDb),
      conflictsRepo: createNoteConflictsRepository(pcDb),
    };
    const androidDeps = {
      deviceId: 'device-Android',
      notesRepo: createNotesRepository(androidDb),
      asksRepo: createAsksRepository(androidDb),
      termsRepo: createTermsRepository(androidDb),
      conflictsRepo: createNoteConflictsRepository(androidDb),
    };

    const androidDiff = await exportOwnSyncFile(androidDeps); // 何も無い状態でエクスポート
    await importSyncFiles([androidDiff], pcDeps);
    const fullSnapshot = await exportFullSnapshot(pcDeps);

    // PCへ送った後・受け取る前に、Androidでさらに別の発言をした状況を模す
    await androidDeps.notesRepo.applyCommit('udp', 'PCに送った後にAndroidで聞いた説明', [], 'device-Android', 99);

    await importSyncFiles([fullSnapshot], androidDeps);

    // 上書きなら消えていたはずのローカル編集が残っている
    expect((await androidDeps.notesRepo.getByTermId('udp'))?.body).toBe('PCに送った後にAndroidで聞いた説明');
  });
});
