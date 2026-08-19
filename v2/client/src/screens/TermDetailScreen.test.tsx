import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { buildTermRecord, type NoteRecord } from '@it-index/shared';
import type { NotesRepository } from '../repositories/notes';
import type { TermsRepository } from '../repositories/terms';
import TermDetailScreen from './TermDetailScreen';

// diagrams描画の実体(mermaidの実描画)はMermaidDiagram.test.tsxで検証済み。ここでは
// TermDetailScreenがdiagramsをMermaidDiagramへ渡していることだけを確認する。
vi.mock('../lib/MermaidDiagram', () => ({
  default: ({ code }: { code: string }) => <div data-testid="mermaid-stub">{code}</div>,
}));

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
    upsertFromSync: () => Promise.resolve(),
    upsertFromAi: () => Promise.resolve(),
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
    applyCommit: (termId, body, diagrams, deviceId, at) => {
      note = { termId, body, diagrams, updatedAt: at, lastEditedBy: deviceId, noteHistory: note ? [...note.noteHistory] : [] };
      return Promise.resolve();
    },
    upsertFromSync: (n) => {
      note = n;
      return Promise.resolve();
    },
    applyConflictResolution: (termId, body, diagrams, deviceId, at) => {
      note = { termId, body, diagrams, updatedAt: at, lastEditedBy: deviceId, noteHistory: note ? [...note.noteHistory] : [] };
      return Promise.resolve();
    },
    adoptPeerDecision: (n) => {
      note = n;
      return Promise.resolve();
    },
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
        onOpenChat={() => {}}
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
        onOpenChat={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText('この語は見つかりませんでした。')).toBeTruthy());
  });

  it('ノート欄の見出しは「理解のために調べたこと」で、本文欄は固定行数(rows)を持たない(内側スクロールをやめ縦に伸びるテキストボックスにする。本人指定レビュー反映)', async () => {
    render(
      <TermDetailScreen
        termId={term.id}
        termsRepo={fakeTermsRepo()}
        notesRepo={fakeNotesRepo()}
        deviceId="device-1"
        onBack={() => {}}
        onDeleted={() => {}}
        onOpenChat={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByRole('heading', { name: /HTTP/ })).toBeTruthy());
    expect(screen.getByRole('heading', { name: '理解のために調べたこと' })).toBeTruthy();
    expect(screen.queryByText('AI補足ノート')).toBeNull();

    const textarea = screen.getByLabelText('ノート本文');
    expect(textarea.hasAttribute('rows')).toBe(false);
  });

  it('ノート本文を編集して保存できる', async () => {
    const notesRepo = fakeNotesRepo();
    render(
      <TermDetailScreen
        termId={term.id}
        termsRepo={fakeTermsRepo()}
        notesRepo={notesRepo}
        deviceId="device-1"
        onBack={() => {}}
        onDeleted={() => {}}
        onOpenChat={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByRole('heading', { name: /HTTP/ })).toBeTruthy());

    const textarea = screen.getByLabelText('ノート本文');
    fireEvent.change(textarea, { target: { value: 'ポート80/443を使う' } });
    fireEvent.click(screen.getByText('保存する'));

    await waitFor(() => expect(notesRepo.saveBody).toHaveBeenCalledWith(term.id, 'ポート80/443を使う', 'device-1', expect.any(Number)));
  });

  it('ノートにdiagramsがある場合、各コードをMermaidDiagramへ渡す', async () => {
    const note: NoteRecord = {
      termId: term.id,
      body: '調べたこと',
      diagrams: ['graph TD;A-->B;', 'sequenceDiagram;A->>B: hi'],
      updatedAt: 1,
      lastEditedBy: 'device-1',
      noteHistory: [],
    };
    render(
      <TermDetailScreen
        termId={term.id}
        termsRepo={fakeTermsRepo()}
        notesRepo={fakeNotesRepo(note)}
        deviceId="device-1"
        onBack={() => {}}
        onDeleted={() => {}}
        onOpenChat={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getAllByTestId('mermaid-stub')).toHaveLength(2));
    expect(screen.getAllByTestId('mermaid-stub')[0].textContent).toBe('graph TD;A-->B;');
    expect(screen.getAllByTestId('mermaid-stub')[1].textContent).toBe('sequenceDiagram;A->>B: hi');
  });

  it('削除確認→削除するとonDeletedが呼ばれる', async () => {
    const onDeleted = vi.fn();
    render(
      <TermDetailScreen
        termId={term.id}
        termsRepo={fakeTermsRepo()}
        notesRepo={fakeNotesRepo()}
        deviceId="device-1"
        onBack={() => {}}
        onDeleted={onDeleted}
        onOpenChat={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByRole('heading', { name: /HTTP/ })).toBeTruthy());
    fireEvent.click(screen.getByText('この語を削除'));
    fireEvent.click(screen.getByText('削除する'));

    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(term.id));
  });
});
