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
  /**
   * 削除した後の後始末（未取り込みチャットの整理・検索画面への遷移）。呼び出し元（App）の責務。
   * 削除後にこの語を表示し続けても意味が無いため、必ず画面を離れる。
   */
  onDeleted: (termId: string) => void;
}

export default function TermDetailScreen({ termId, termsRepo, notesRepo, onBack, onStartChat, onDeleted }: TermDetailScreenProps) {
  const [term, setTerm] = useState<TermRecord | null | undefined>(undefined); // undefined = 読み込み中
  const [note, setNote] = useState<NoteRecord | undefined>(undefined);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    setTerm(undefined);
    setNote(undefined);
    setConfirmingDelete(false);
    Promise.all([termsRepo.getById(termId), notesRepo.getByTermId(termId)]).then(([t, n]) => {
      setTerm(t ?? null);
      setNote(n);
    });
  }, [termId, termsRepo, notesRepo]);

  async function handleDelete() {
    await termsRepo.softDelete(termId, Date.now());
    onDeleted(termId);
  }

  return (
    <div className="term-detail">
      <div className="term-detail-top-row">
        <button type="button" className="term-detail-back" onClick={onBack}>
          ← 検索に戻る
        </button>
        {term && !confirmingDelete && (
          <button type="button" className="btn-text term-detail-delete" onClick={() => setConfirmingDelete(true)}>
            この語を削除
          </button>
        )}
        {term && confirmingDelete && (
          <span className="term-detail-delete-confirm">
            本当に削除しますか？
            <button type="button" className="btn-secondary" onClick={() => void handleDelete()}>
              削除する
            </button>
            <button type="button" className="btn-text" onClick={() => setConfirmingDelete(false)}>
              キャンセル
            </button>
          </span>
        )}
      </div>

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
