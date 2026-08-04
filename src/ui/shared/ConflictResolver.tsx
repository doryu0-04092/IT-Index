import { useState } from 'react';
import type { NoteConflict } from '../../core/mergeSnapshot';
import type { ManualSyncDeps } from '../../manualSync/sync';
import type { NoteRecord } from '../../types';

/**
 * 両方の端末で同じ語を更新していた場合の確認・解決（要件定義書§5.5）。
 *
 * マージ自体は決定的に済んでいる——`mergeSnapshot()` が updatedAt の新しい方を採用済みで、
 * データが失われた状態にはならない。ただしそれは機械的な判定なので、「古い方が実は良かった」
 * ことがある。ここでは両方を並べて提示し、選び直せるようにする。
 * 以前は「自動で統合できなかった項目が◯件あります。後で確認できます」と案内しながら、
 * その確認先がどこにも無かった（2026-08-05に追加）。
 *
 * 選び直しは `notesRepo.applyCommit()` で行う——上書き前の版が `noteHistory` に積まれるため、
 * この操作自体も後から追える。
 *
 * PC版・Android版で表示内容もCSSクラスも同一のため、`src/ui/shared/` に置いて共有する
 * （`MermaidDiagram.tsx` と同じ扱い）。狭幅では2案が縦に折り返る（`.link-conflict-sides`）。
 */
export default function ConflictResolver({ conflicts, deps }: { conflicts: NoteConflict[]; deps: ManualSyncDeps }) {
  const [open, setOpen] = useState(false);
  const [resolved, setResolved] = useState<Record<string, 'local' | 'remote'>>({});

  async function choose(conflict: NoteConflict, side: 'local' | 'remote') {
    const chosen = side === 'local' ? conflict.local : conflict.remote;
    await deps.notesRepo.applyCommit(conflict.termId, chosen.body, chosen.diagrams, deps.deviceId, Date.now());
    setResolved((prev) => ({ ...prev, [conflict.termId]: side }));
  }

  if (!open) {
    return (
      <div className="link-conflicts">
        <p className="search-status">
          両方の端末で更新されていた語が{conflicts.length}件あります。新しい方を採用しましたが、選び直せます。
        </p>
        <button type="button" className="btn-secondary" onClick={() => setOpen(true)}>
          確認する（{conflicts.length}件）
        </button>
      </div>
    );
  }

  return (
    <div className="link-conflicts">
      <p className="search-status">採用したい方を選んでください。選ばなければ新しい方（自動採用）のままです。</p>
      <ul className="link-conflict-list">
        {conflicts.map((c) => (
          <li key={c.termId} className="link-conflict">
            <h4 className="link-conflict-term">{c.termId}</h4>
            {resolved[c.termId] ? (
              <p className="search-status">
                {resolved[c.termId] === 'local' ? 'この端末の内容' : '相手の端末の内容'}にしました。
              </p>
            ) : (
              <div className="link-conflict-sides">
                <ConflictSide title="この端末の内容" note={c.local} onChoose={() => void choose(c, 'local')} />
                <ConflictSide title="相手の端末の内容" note={c.remote} onChoose={() => void choose(c, 'remote')} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ConflictSide({ title, note, onChoose }: { title: string; note: NoteRecord; onChoose: () => void }) {
  return (
    <div className="link-conflict-side">
      <h5 className="link-conflict-side-title">
        {title}
        <span className="search-result-reading">{new Date(note.updatedAt).toLocaleString('ja-JP')}</span>
      </h5>
      <p className="link-conflict-body">{note.body}</p>
      <button type="button" className="btn-secondary" onClick={onChoose}>
        こちらを採用
      </button>
    </div>
  );
}
