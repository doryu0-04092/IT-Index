import { useEffect, useRef, useState } from 'react';
import type { NoteRecord, TermRecord } from '@it-index/shared';
import MermaidDiagram from '../lib/MermaidDiagram';
import Skeleton from '../lib/Skeleton';
import type { NotesRepository } from '../repositories/notes';
import type { TermsRepository } from '../repositories/terms';

export interface TermDetailScreenProps {
  termId: string;
  termsRepo: TermsRepository;
  notesRepo: NotesRepository;
  /** ノート編集保存・deviceId不明(起動直後)の間は保存できない */
  deviceId: string | null;
  onBack: () => void;
  /** 削除した後の後始末(呼び出し元(App)の責務。削除後は必ず画面を離れる) */
  onDeleted: (termId: string) => void;
  /** 「AIに聞く」ボタン。この語にひも付くチャットを開く(要件定義書§5.3) */
  onOpenChat: (termId: string) => void;
  /**
   * 取り込み(確定)完了の通知(#167)。この画面を開いたまま裏で取り込みが完了した場合に、
   * ノート・語の表示を追従させる再読込トリガー。編集中(未保存の下書きがある間)は
   * 下書きを上書きしない——操作を阻害しないための必須条件。
   */
  commitRefreshTick?: number;
}

/**
 * 用語詳細画面。要件定義書§4.1の通り、term/readings/field/summaryは不変(「思い出す用」)、
 * ノートbody(Markdownテキスト)はそのまま<pre>で表示+テキストエリアで編集保存する
 * (Markdownレンダラは追加しない。§5「やらないこと」)。diagramsは移植元
 * (../../../src/ui/pc/TermDetailScreen.tsx)と同じくMermaidDiagramで描画する
 * (構文エラー時はMermaidDiagram側でコードブロック表示にフォールバックする)。
 */
export default function TermDetailScreen({
  termId,
  termsRepo,
  notesRepo,
  deviceId,
  onBack,
  onDeleted,
  onOpenChat,
  commitRefreshTick = 0,
}: TermDetailScreenProps) {
  const [term, setTerm] = useState<TermRecord | null | undefined>(undefined); // undefined = 読み込み中
  const [note, setNote] = useState<NoteRecord | undefined>(undefined);
  const [draftBody, setDraftBody] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const noteEditorRef = useRef<HTMLTextAreaElement | null>(null);

  // 編集中(下書きが保存済み本文と異なる)かどうか。背景の自動反映(#167)が下書きを
  // 上書きしないための判定に使う。render中のref書き込みはreact-hooks/purityに
  // 触れるため、毎render後のeffectで更新する(依存配列なし=常に最新)
  const dirtyRef = useRef(false);
  useEffect(() => {
    dirtyRef.current = draftBody !== (note?.body ?? '');
  });

  // termId変更時の状態リセットは呼び出し元(App.tsx)が<main key={screenKey(screen)}>で
  // termIdを含むkeyを持たせているため、この画面自体が丸ごと再マウントされて不要
  // (初期値のundefined/false/'idle'に自然に戻る)。ここでは取得結果の反映だけを行う。
  // commitRefreshTick: この画面を開いたまま取り込みが完了した場合の追従(#167)。
  // 語・ノート表示は差し替えるが、編集中の下書きだけは上書きしない(操作を阻害しない)。
  useEffect(() => {
    void Promise.all([termsRepo.getById(termId), notesRepo.getByTermId(termId)]).then(([t, n]) => {
      setTerm(t ?? null);
      setNote(n);
      if (!dirtyRef.current) {
        setDraftBody(n?.body ?? '');
      }
    });
  }, [termId, termsRepo, notesRepo, commitRefreshTick]);

  // ノート欄は内側スクロール(スライドバー)をやめ、本文の長さに合わせて縦に伸びる
  // テキストボックスにする(本人指定)。rows固定のままだとブラウザ既定でtextarea内部だけが
  // スクロールしてしまうため、本文が変わるたび高さをscrollHeightへ合わせ直す。
  useEffect(() => {
    const el = noteEditorRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draftBody]);

  async function handleDelete() {
    await termsRepo.softDelete(termId, Date.now());
    onDeleted(termId);
  }

  async function handleSaveNote() {
    if (!deviceId) return;
    setSaveState('saving');
    await notesRepo.saveBody(termId, draftBody, deviceId, Date.now());
    setNote(await notesRepo.getByTermId(termId));
    setSaveState('saved');
  }

  const bodyChanged = draftBody !== (note?.body ?? '');

  return (
    <div className="term-detail">
      <div className="term-detail-top-row">
        <button type="button" className="back-link" onClick={onBack}>
          ← 戻る
        </button>
        {term && !confirmingDelete && (
          <button type="button" className="btn-text term-detail-delete" onClick={() => setConfirmingDelete(true)}>
            この語を削除
          </button>
        )}
        {term && confirmingDelete && (
          <span className="term-detail-delete-confirm">
            本当に削除しますか?
            <button type="button" className="btn-danger" onClick={() => void handleDelete()}>
              削除する
            </button>
            <button type="button" className="btn-text" onClick={() => setConfirmingDelete(false)}>
              キャンセル
            </button>
          </span>
        )}
      </div>

      {term === undefined && (
        <>
          <p className="status-text">読み込み中です…</p>
          <Skeleton />
        </>
      )}
      {term === null && <p className="status-text">この語は見つかりませんでした。</p>}

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

          <div className="term-detail-ai-row">
            <button type="button" className="btn-secondary" onClick={() => onOpenChat(termId)}>
              AIに聞く
            </button>
          </div>

          <section className="term-detail-notes">
            <h3>理解のために調べたこと</h3>
            {note && note.diagrams.length > 0 && (
              <div className="term-detail-diagrams">
                {note.diagrams.map((d, i) => <MermaidDiagram key={i} code={d} />)}
              </div>
            )}
            <textarea
              ref={noteEditorRef}
              className="term-detail-note-editor"
              value={draftBody}
              onChange={(e) => {
                setDraftBody(e.target.value);
                setSaveState('idle');
              }}
              placeholder="この語について調べたことをMarkdownで書けます"
              aria-label="ノート本文"
            />
            <div className="term-detail-note-actions">
              <button
                type="button"
                className="btn-primary"
                onClick={() => void handleSaveNote()}
                disabled={!deviceId || !bodyChanged || saveState === 'saving'}
              >
                {saveState === 'saving' ? '保存中…' : '保存する'}
              </button>
              {saveState === 'saved' && !bodyChanged && <span className="status-text">保存しました</span>}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
