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
  const { chooseLocal, merge, mergeErrors } = useConflictResolution({
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
      <button type="button" onClick={() => void merge(conflict)}>
        AIで統合
      </button>
      <p data-testid="merge-error">{mergeErrors['conflict-1'] ?? ''}</p>
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
