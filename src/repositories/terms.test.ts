import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ItIndexDB } from '../db';
import { buildTermRecord, createTermsRepository } from './terms';

describe('TermsRepository', () => {
  let db: ItIndexDB;

  beforeEach(() => {
    db = new ItIndexDB(`test-terms-${crypto.randomUUID()}`);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('getAll excludes tombstoned records', async () => {
    const repo = createTermsRepository(db);
    const now = Date.now();
    const alive = buildTermRecord({ term: 'API', readings: ['エーピーアイ'], summary: '', field: 'ソフトウェア', origin: 'seed', now });
    const deleted = {
      ...buildTermRecord({ term: 'DEAD', readings: ['デッド'], summary: '', field: 'ソフトウェア', origin: 'seed', now }),
      deletedAt: now,
    };

    await repo.bulkPutFromSeed([alive, deleted]);
    const all = await repo.getAll();

    expect(all.map((t) => t.id)).toEqual([alive.id]);
  });

  // 回帰: シードのレコードは常に deletedAt:null で組み立てられるため、既存の tombstone を
  // 引き継がないと「利用者が削除した内蔵語が、次のシード更新で全部復活する」ことになる。
  it('bulkPutFromSeed keeps a term deleted when the user has already deleted it', async () => {
    const repo = createTermsRepository(db);
    const now = Date.now();
    const term = buildTermRecord({ term: 'API', readings: ['エーピーアイ'], summary: '', field: 'ソフトウェア', origin: 'seed', now });

    await repo.bulkPutFromSeed([term]);
    await repo.softDelete(term.id, now + 1);
    // 次のシード更新（同じ語が再び入ってくる）
    await repo.bulkPutFromSeed([term]);

    expect(await repo.getById(term.id)).toBeUndefined();
    expect((await repo.getAll()).map((t) => t.id)).not.toContain(term.id);
  });

  // 回帰: 同期の送信データに getAll() を使うと tombstone が相手に伝わらず、相手が持っている
  // 削除前のレコードがマージで戻ってきてしまう。同期用の取得は削除済みも含める必要がある。
  it('getAllForSync includes tombstoned records so deletions can propagate', async () => {
    const repo = createTermsRepository(db);
    const now = Date.now();
    const term = buildTermRecord({ term: 'API', readings: ['エーピーアイ'], summary: '', field: 'ソフトウェア', origin: 'seed', now });

    await repo.bulkPutFromSeed([term]);
    await repo.softDelete(term.id, now + 1);

    expect((await repo.getAll()).map((t) => t.id)).not.toContain(term.id);
    const forSync = await repo.getAllForSync();
    expect(forSync.map((t) => t.id)).toContain(term.id);
    expect(forSync.find((t) => t.id === term.id)?.deletedAt).toBe(now + 1);
  });

  it('makeTermId is derived deterministically from term (normalize)', async () => {
    const repo = createTermsRepository(db);
    const now = Date.now();
    const term = buildTermRecord({ term: 'TCP/IP', readings: ['ティーシーピーアイピー'], summary: '', field: 'ネットワーク', origin: 'seed', now });

    await repo.bulkPutFromSeed([term]);
    const found = await repo.getById(term.id);

    expect(found?.term).toBe('TCP/IP');
    expect(term.id).toBe('tcp/ip');
  });
});
