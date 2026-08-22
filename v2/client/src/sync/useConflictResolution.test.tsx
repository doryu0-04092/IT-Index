import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AiClient } from '../ai/aiClient';
import { ItIndexDB } from '../db';
import { createNoteConflictsRepository } from '../repositories/noteConflicts';
import { createNotesRepository } from '../repositories/notes';
import type { NoteConflictRecord } from '../types';
import { useConflictResolution } from './useConflictResolution';

/**
 * 解消ロジック(#157で切り出し)の、画面経由では作りにくい条件のテスト(#171):
 * deviceId未確定(起動直後)と、AI統合がApiRequestError以外で失敗した場合。
 * どちらも「利用者のデータを壊さない」ことが要点。
 */
function makeConflictRecord(): NoteConflictRecord {
  const base = { termId: 'tcp-ip', diagrams: [], resolvedAt: null, noteHistory: [] };
  return {
    id: 'conflict-1',
    termId: 'tcp-ip',
    detectedAt: 1000,
    peerDeviceId: 'device-2',
    local: { ...base, body: 'この端末の内容', updatedAt: 100, lastEditedBy: 'device-1' },
    remote: { ...base, body: '相手の端末の内容', updatedAt: 200, lastEditedBy: 'device-2' },
    resolution: null,
    merged: null,
    resolvedAt: null,
    syncEventId: 'event-1',
    closedReason: null,
    closedAt: null,
  };
}

/** hookを最小のコンポーネントに載せて、ボタン操作から呼び出す */
function Harness({
  deviceId,
  aiClient,
  db,
  onAfterResolve,
}: {
  deviceId: string | null;
  aiClient: AiClient;
  db: ItIndexDB;
  onAfterResolve: () => Promise<void>;
}) {
  const conflict = makeConflictRecord();
  const { chooseLocal, mergeAll, mergeErrors } = useConflictResolution({
    deviceId,
    notesRepo: createNotesRepository(db),
    noteConflictsRepo: createNoteConflictsRepository(db),
    aiClient,
    onAfterResolve,
  });
  return (
    <div>
      <button type="button" onClick={() => chooseLocal(conflict)}>
        こちらを採用
      </button>
      <button type="button" onClick={() => void mergeAll([conflict])}>
        AIで統合
      </button>
      {/* #238: 統合はグループ単位になったので、エラーも語(termId)をキーに持つ */}
      <p data-testid="merge-error">{mergeErrors[conflict.termId] ?? ''}</p>
    </div>
  );
}

describe('useConflictResolution', () => {
  const dbs: ItIndexDB[] = [];
  afterEach(() => {
    cleanup();
    for (const db of dbs) db.close();
    dbs.length = 0;
  });

  function makeDb() {
    const db = new ItIndexDB(`test-useConflictResolution-${Math.random()}`);
    dbs.push(db);
    return db;
  }

  it('deviceIdが未確定(起動直後)なら何も書き込まない', async () => {
    const db = makeDb();
    const onAfterResolve = vi.fn(() => Promise.resolve());

    render(<Harness deviceId={null} aiClient={{ send: vi.fn() }} db={db} onAfterResolve={onAfterResolve} />);
    fireEvent.click(screen.getByRole('button', { name: 'こちらを採用' }));

    // 反映も一覧再読込も起きない(deviceIdが無いままnotesへ書くと、
    // lastEditedByが空文字の壊れたレコードになるため)
    await waitFor(() => expect(onAfterResolve).not.toHaveBeenCalled());
    expect(await createNotesRepository(db).getByTermId('tcp-ip')).toBeUndefined();
  });

  it('AI統合がApiRequestError以外(通常のError)で失敗した場合もメッセージを表示し、適用しない', async () => {
    const db = makeDb();
    const aiClient: AiClient = { send: vi.fn().mockRejectedValue(new Error('想定外の失敗')) };

    render(<Harness deviceId="device-1" aiClient={aiClient} db={db} onAfterResolve={() => Promise.resolve()} />);
    fireEvent.click(screen.getByRole('button', { name: 'AIで統合' }));

    await waitFor(() => expect(screen.getByTestId('merge-error').textContent).toBe('想定外の失敗'));
    expect(await createNotesRepository(db).getByTermId('tcp-ip')).toBeUndefined();
  });

  it('AI統合がError以外の値でthrowした場合も文字列化して表示する(クラッシュさせない)', async () => {
    const db = makeDb();
    const aiClient: AiClient = { send: vi.fn().mockRejectedValue('文字列のthrow') };

    render(<Harness deviceId="device-1" aiClient={aiClient} db={db} onAfterResolve={() => Promise.resolve()} />);
    fireEvent.click(screen.getByRole('button', { name: 'AIで統合' }));

    await waitFor(() => expect(screen.getByTestId('merge-error').textContent).toBe('文字列のthrow'));
  });
});
/**
 * **3端末以上を1回で統一する(#238)。**
 *
 * 実機で「PC + Android2台で両方を統合したら、どちらも採用中になったのにAndroidの競合が
 * 解消されない」と報告された。相手ごとに統合していたため、
 * (1)1回目の結果を2回目でもう一度AIに通して情報が薄まる
 * (2)決定が2回に分かれて相手が収束しない、の2つが起きていた。
 */
describe('mergeAll(3端末以上)', () => {
  const dbs: ItIndexDB[] = [];
  afterEach(() => {
    cleanup();
    for (const db of dbs) db.close();
    dbs.length = 0;
  });

  function makeDb() {
    const db = new ItIndexDB(`merge-all-${Math.random()}`);
    dbs.push(db);
    return db;
  }

  function conflictWith(peer: string, body: string, id: string): NoteConflictRecord {
    const base = makeConflictRecord();
    return {
      ...base,
      id,
      peerDeviceId: peer,
      remote: { ...base.remote, body, lastEditedBy: peer },
    };
  }

  function GroupHarness({ db, aiClient, conflicts }: { db: ItIndexDB; aiClient: AiClient; conflicts: NoteConflictRecord[] }) {
    const { mergeAll, mergeErrors } = useConflictResolution({
      deviceId: 'device-pc',
      notesRepo: createNotesRepository(db),
      noteConflictsRepo: createNoteConflictsRepository(db),
      aiClient,
      onAfterResolve: async () => {},
    });
    return (
      <div>
        <button type="button" onClick={() => void mergeAll(conflicts)}>
          まとめて統合
        </button>
        <p data-testid="merge-error">{mergeErrors[conflicts[0].termId] ?? ''}</p>
      </div>
    );
  }

  it('相手2台ぶんを1回のAI呼び出しで統合し、全件まとめて決着する', async () => {
    const db = makeDb();
    const conflicts = [
      conflictWith('device-a1', 'Android1の内容', 'c-a1'),
      conflictWith('device-a2', 'Android2の内容', 'c-a2'),
    ];
    const repo = createNoteConflictsRepository(db);
    for (const c of conflicts) await db.noteConflicts.put(c);

    const aiClient: AiClient = {
      send: vi.fn().mockResolvedValue({
        text: JSON.stringify({ body: '3端末ぶんを統合した内容', diagrams: [] }),
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };

    render(<GroupHarness db={db} aiClient={aiClient} conflicts={conflicts} />);
    fireEvent.click(screen.getByRole('button', { name: 'まとめて統合' }));

    await waitFor(async () => {
      const note = await createNotesRepository(db).getByTermId(conflicts[0].termId);
      expect(note?.body).toBe('3端末ぶんを統合した内容');
    });

    // **AIは1回だけ。** 相手ごとに呼ぶと情報が薄まり、決定も分裂する
    expect(aiClient.send).toHaveBeenCalledTimes(1);

    // **全件まとめて決着する**(片方だけ採用中、が起きない)
    const all = await repo.getAllOrdered();
    expect(all.every((c) => c.resolution === 'merged')).toBe(true);
    expect(await repo.getOpen()).toHaveLength(0);
  });

  it('AIが失敗したら何も適用しない(部分的に解消されない)', async () => {
    const db = makeDb();
    const conflicts = [
      conflictWith('device-a1', 'Android1の内容', 'c-a1'),
      conflictWith('device-a2', 'Android2の内容', 'c-a2'),
    ];
    const repo = createNoteConflictsRepository(db);
    for (const c of conflicts) await db.noteConflicts.put(c);

    const aiClient: AiClient = { send: vi.fn().mockRejectedValue(new Error('上限に達しました')) };

    render(<GroupHarness db={db} aiClient={aiClient} conflicts={conflicts} />);
    fireEvent.click(screen.getByRole('button', { name: 'まとめて統合' }));

    await waitFor(() => expect(screen.getByTestId('merge-error').textContent).toContain('上限に達しました'));

    // **1件も解消されていない**(中途半端に一部だけ適用されると不整合になる)
    expect(await repo.getOpen()).toHaveLength(2);
    expect(await createNotesRepository(db).getByTermId(conflicts[0].termId)).toBeUndefined();
  });
});

