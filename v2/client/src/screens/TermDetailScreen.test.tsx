import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { buildTermRecord, type NoteRecord } from '@it-index/shared';
import type { NotesRepository } from '../repositories/notes';
import type { TermsRepository } from '../repositories/terms';
import TermDetailScreen from './TermDetailScreen';

const term = buildTermRecord({ term: 'HTTP', readings: ['エイチティーティーピー'], summary: '通信規約', field: 'ネットワーク', origin: 'seed', now: 1 });

function fakeTermsRepo(): TermsRepository {
  let deleted: string | null = null;
  return {
    getAll: () => Promise.resolve([]),
    getAllForSync: () => Promise.resolve([]),
    getById: (id) => Promise.resolve(id === deleted ? undefined : id === term.id ? term : undefined),
    bulkPutFromSeed: () => Promise.resolve(),
    softDelete: (id) => {
      deleted = id;
      return Promise.resolve();
    },
  };
}

function fakeNotesRepo(initial?: NoteRecord): NotesRepository {
  let note = initial;
  const saveBody = vi.fn((termId: string, body: string, deviceId: string, at: number) => {
    note = { termId, body, diagrams: note?.diagrams ?? [], updatedAt: at, lastEditedBy: deviceId, noteHistory: note ? [...note.noteHistory] : [] };
    return Promise.resolve();
  });
  return {
    getByTermId: () => Promise.resolve(note),
    getAll: () => Promise.resolve(note ? [note] : []),
    saveBody,
  };
}

describe('TermDetailScreen', () => {
  afterEach(cleanup);

  it('不変フィールド(term/readings/field/summary)を表示する', async () => {
    render(
      <TermDetailScreen
        termId={term.id}
        termsRepo={fakeTermsRepo()}
        notesRepo={fakeNotesRepo()}
        deviceId="device-1"
        onBack={() => {}}
        onDeleted={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByRole('heading', { name: /HTTP/ })).toBeTruthy());
    expect(screen.getByText('通信規約')).toBeTruthy();
    expect(screen.getByText('ネットワーク')).toBeTruthy();
  });

  it('見つからない語は「見つかりませんでした」を表示する', async () => {
    render(
      <TermDetailScreen
        termId="not-exist"
        termsRepo={fakeTermsRepo()}
        notesRepo={fakeNotesRepo()}
        deviceId="device-1"
        onBack={() => {}}
        onDeleted={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText('この語は見つかりませんでした。')).toBeTruthy());
  });

  it('ノート本文を編集して保存できる', async () => {
    const notesRepo = fakeNotesRepo();
    render(
      <TermDetailScreen termId={term.id} termsRepo={fakeTermsRepo()} notesRepo={notesRepo} deviceId="device-1" onBack={() => {}} onDeleted={() => {}} />,
    );

    await waitFor(() => expect(screen.getByRole('heading', { name: /HTTP/ })).toBeTruthy());

    const textarea = screen.getByLabelText('ノート本文');
    fireEvent.change(textarea, { target: { value: 'ポート80/443を使う' } });
    fireEvent.click(screen.getByText('保存する'));

    await waitFor(() => expect(notesRepo.saveBody).toHaveBeenCalledWith(term.id, 'ポート80/443を使う', 'device-1', expect.any(Number)));
  });

  it('削除確認→削除するとonDeletedが呼ばれる', async () => {
    const onDeleted = vi.fn();
    render(
      <TermDetailScreen termId={term.id} termsRepo={fakeTermsRepo()} notesRepo={fakeNotesRepo()} deviceId="device-1" onBack={() => {}} onDeleted={onDeleted} />,
    );

    await waitFor(() => expect(screen.getByRole('heading', { name: /HTTP/ })).toBeTruthy());
    fireEvent.click(screen.getByText('この語を削除'));
    fireEvent.click(screen.getByText('削除する'));

    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(term.id));
  });
});
