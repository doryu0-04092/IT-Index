import { describe, expect, it } from 'vitest';
import { buildTermRecord } from '../repositories/terms';
import type { NoteRecord } from '../types';
import { buildNoteFile, parseNoteFile } from './noteFile';

const term = buildTermRecord({
  term: 'CORS',
  readings: ['シーオーアールエス'],
  summary: '異なるオリジン間の通信をブラウザが制御する仕組み。',
  field: 'セキュリティ',
  origin: 'ai',
  now: 1_700_000_000_000,
});

function note(overrides: Partial<NoteRecord> = {}): NoteRecord {
  return {
    termId: term.id,
    body: '',
    diagrams: [],
    updatedAt: 1_700_000_000_000,
    lastEditedBy: 'device-A',
    noteHistory: [],
    ...overrides,
  };
}

describe('buildNoteFile / parseNoteFile', () => {
  it('round-trips body and diagrams through the markdown representation', () => {
    const n = note({
      body: '異なるオリジン間の通信をブラウザが制御する仕組み。\n\nAPIアクセス時などで利用される。',
      diagrams: ['graph LR\n  A --> B'],
    });

    const file = buildNoteFile(term, n);
    const parsed = parseNoteFile(file);

    expect(parsed.body).toBe(n.body);
    expect(parsed.diagrams).toEqual(n.diagrams);
  });

  it('includes reference-only front matter that is ignored on parse', () => {
    const file = buildNoteFile(term, note({ body: '本文' }));

    expect(file).toContain('term: CORS');
    expect(file).toContain('field: セキュリティ');

    const parsed = parseNoteFile(file);
    expect(parsed.body).toBe('本文');
  });

  it('produces an empty body and no diagrams when there is no note yet', () => {
    const file = buildNoteFile(term, undefined);
    const parsed = parseNoteFile(file);

    expect(parsed.body).toBe('');
    expect(parsed.diagrams).toEqual([]);
  });

  it('round-trips multiple diagrams in order', () => {
    const n = note({ body: '本文', diagrams: ['graph LR\n  A --> B', 'sequenceDiagram\n  A->>B: hi'] });

    const parsed = parseNoteFile(buildNoteFile(term, n));

    expect(parsed.diagrams).toEqual(n.diagrams);
  });
});
