import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ItIndexDB } from '../db';
import { createAsksRepository } from '../repositories/asks';
import { createNoteConflictsRepository } from '../repositories/noteConflicts';
import { createNotesRepository } from '../repositories/notes';
import { createTermsRepository } from '../repositories/terms';
import { generatePairingKey, importPairingKey } from './crypto';
import { openAndMerge, sealSnapshot } from './runPairingExchange';

describe('sealSnapshot / openAndMerge', () => {
  let dbA: ItIndexDB;
  let dbB: ItIndexDB;

  beforeEach(() => {
    dbA = new ItIndexDB(`test-pairing-a-${crypto.randomUUID()}`);
    dbB = new ItIndexDB(`test-pairing-b-${crypto.randomUUID()}`);
  });

  afterEach(async () => {
    await dbA.delete();
    await dbB.delete();
  });

  function depsFor(db: ItIndexDB, deviceId: string) {
    return {
      deviceId,
      notesRepo: createNotesRepository(db),
      asksRepo: createAsksRepository(db),
      termsRepo: createTermsRepository(db),
      conflictsRepo: createNoteConflictsRepository(db),
    };
  }

  it('returns ok:false with a Japanese reason when opened with the wrong key', async () => {
    const depsA = depsFor(dbA, 'device-A');
    const depsB = depsFor(dbB, 'device-B');

    const keyA = await importPairingKey(generatePairingKey());
    const keyB = await importPairingKey(generatePairingKey());
    expect(keyA).not.toBeNull();
    expect(keyB).not.toBeNull();

    const { envelope } = await sealSnapshot(keyA!, depsA);
    const result = await openAndMerge(keyB!, envelope, depsB);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('鍵が合いません。QRを読み直してください。');
    }
  });

  it('returns ok:false for a corrupted envelope', async () => {
    const depsB = depsFor(dbB, 'device-B');
    const key = await importPairingKey(generatePairingKey());
    expect(key).not.toBeNull();

    const result = await openAndMerge(key!, '{ not valid json', depsB);
    expect(result.ok).toBe(false);
  });

  it('symmetric exchange: A seals -> B opens/merges, then B seals -> A opens/merges, ending in identical state', async () => {
    const depsA = depsFor(dbA, 'device-A');
    const depsB = depsFor(dbB, 'device-B');

    // 事前状態: AとBがそれぞれ別のtermについてメモを持っている
    await depsA.notesRepo.applyCommit('tcp/ip', 'Aで聞いた説明', [], 'device-A', 10);
    await depsB.notesRepo.applyCommit('udp', 'Bで聞いた説明', [], 'device-B', 20);

    const key = await importPairingKey(generatePairingKey());
    expect(key).not.toBeNull();

    // 待ち受け役=B、接続役=A という想定だが、呼ぶ関数はどちらも同じ。
    // Bは HostView と同じ順序（先にseal、後でmerge）で処理する
    // ——マージ後にsealすると、返信に「Aから今取り込んだばかりの分」が混ざってしまい、
    // Aが「自分が新しく渡したものは何件か」を返信から正確に算出できなくなる。
    // ① A: 自分が知っている全部を封筒にして送る
    const sealedA = await sealSnapshot(key!, depsA);
    // ② B: 受け取る前に、まず自分のマージ前スナップショットを封印しておく
    const sealedB = await sealSnapshot(key!, depsB);
    // ③ B: 受け取って復号しマージする（自分が渡した分=sealedB.fileと比較し、送信分もわかる）
    const resultAtB = await openAndMerge(key!, sealedA.envelope, depsB, sealedB.file);
    expect(resultAtB.ok).toBe(true);
    if (resultAtB.ok) {
      // Aから受け取った tcp/ip が新しく増え、Bが元々持っていた udp をAに渡したはず
      expect(resultAtB.receivedDelta.noteTermIds).toContain('tcp/ip');
      expect(resultAtB.sentDelta.noteTermIds).toContain('udp');
    }

    // ④ B: マージ前に封印しておいたものをそのまま送り返す（HostViewと同じ）
    // ⑤ A: 受け取って復号しマージする
    const resultAtA = await openAndMerge(key!, sealedB.envelope, depsA, sealedA.file);
    expect(resultAtA.ok).toBe(true);
    if (resultAtA.ok) {
      expect(resultAtA.receivedDelta.noteTermIds).toContain('udp');
      expect(resultAtA.sentDelta.noteTermIds).toContain('tcp/ip');
    }

    // 両者とも相手のtermを知っている状態になっている
    expect((await depsA.notesRepo.getByTermId('udp'))?.body).toBe('Bで聞いた説明');
    expect((await depsA.notesRepo.getByTermId('tcp/ip'))?.body).toBe('Aで聞いた説明');
    expect((await depsB.notesRepo.getByTermId('tcp/ip'))?.body).toBe('Aで聞いた説明');
    expect((await depsB.notesRepo.getByTermId('udp'))?.body).toBe('Bで聞いた説明');

    // 最終状態が一致することを、それぞれの全量エクスポート内容で比較して確認する
    const finalA = await sealSnapshot(key!, depsA);
    const finalB = await sealSnapshot(key!, depsB);
    const { open } = await import('./crypto');
    const contentA = JSON.parse((await open(key!, finalA.envelope))!);
    const contentB = JSON.parse((await open(key!, finalB.envelope))!);

    const normalize = (snapshot: { notes: Array<{ termId: string; body: string }> }) =>
      snapshot.notes.map((n) => ({ termId: n.termId, body: n.body })).sort((a, b) => a.termId.localeCompare(b.termId));

    expect(normalize(contentA)).toEqual(normalize(contentB));
  });
});
