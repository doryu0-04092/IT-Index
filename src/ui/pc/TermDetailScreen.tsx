import { useEffect, useState } from 'react';
import type { NotesRepository } from '../../repositories/notes';
import type { TermsRepository } from '../../repositories/terms';
import type { NoteRecord, TermRecord } from '../../types';
import MermaidDiagram from '../shared/MermaidDiagram';
import Skeleton from './Skeleton';

export interface TermDetailScreenProps {
  termId: string;
  termsRepo: TermsRepository;
  notesRepo: NotesRepository;
  onBack: () => void;
  onStartChat: (termId: string) => void;
}

export default function TermDetailScreen({ termId, termsRepo, notesRepo, onBack, onStartChat }: TermDetailScreenProps) {
  const [term, setTerm] = useState<TermRecord | null | undefined>(undefined); // undefined = 読み込み中
  const [note, setNote] = useState<NoteRecord | undefined>(undefined);

  useEffect(() => {
    setTerm(undefined);
    setNote(undefined);
    Promise.all([termsRepo.getById(termId), notesRepo.getByTermId(termId)]).then(([t, n]) => {
      setTerm(t ?? null);
      setNote(n);
    });
  }, [termId, termsRepo, notesRepo]);

  return (
    <div className="term-detail">
      <button type="button" className="term-detail-back" onClick={onBack}>
        ← 検索に戻る
      </button>

      {term === undefined && <Skeleton lines={4} />}
      {term === null && <p className="search-status">この語は見つかりませんでした。</p>}

      {term && (
        <>
          <h2>
            {term.term} <span className="term-detail-reading">{term.readings[0]}</span>
          </h2>
          <p className="term-detail-meta">
            {term.field}
            {term.tags.length > 0 && ` ／ ${term.tags.join('、')}`}
          </p>

          {term.summary !== null && (
            <section className="term-detail-summary">
              <h3>初期説明</h3>
              <p>{term.summary}</p>
            </section>
          )}

          <section className="term-detail-notes">
            <h3>理解のために調べたこと</h3>
            {note && note.body.trim() !== '' ? (
              <>
                <p className="term-detail-body">{note.body}</p>
                {note.diagrams.length > 0 && (
                  <div className="term-detail-diagrams">
                    {note.diagrams.map((d, i) => (
                      <MermaidDiagram key={i} code={d} />
                    ))}
                  </div>
                )}
              </>
            ) : (
              <p className="search-status">まだAIに聞いたことがありません。</p>
            )}
            <button type="button" className="btn-primary" onClick={() => onStartChat(termId)}>
              この語についてAIに聞く
            </button>
          </section>
        </>
      )}
    </div>
  );
}
