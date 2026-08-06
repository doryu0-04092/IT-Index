import { useState } from 'react';
import type { AiClient } from '../../ai/aiClient';
import { logAiError } from '../../ai/logError';
import type { NoteConflictsRepository } from '../../repositories/noteConflicts';
import type { NotesRepository } from '../../repositories/notes';
import { resolveConflict } from '../../sync/resolveConflict';
import type { NoteConflictRecord, NoteRecord } from '../../types';

/**
 * 両方の端末で同じ語を更新していた場合の確認・解決（要件定義書§5.5）。
 *
 * マージ自体は決定的に済んでいる——`mergeSnapshot()` が updatedAt の新しい方を採用済みで、
 * データが失われた状態にはならない。ただしそれは機械的な判定なので、「古い方が実は良かった」
 * ことがある。ここでは両方を並べて提示し、選び直せるようにする。
 *
 * 2026-08-07改訂: 競合は検出した瞬間に`noteConflicts`テーブルへ保存済み（`manualSync/sync.ts`）
 * になった。以前は「後で確認できます」と案内しながら、選ばずに画面を離れるとその場限りの
 * データが失われ、確認先もどこにも無かった。今はこのコンポーネントも履歴画面「取り込み履歴」
 * タブも同じ保存済みレコード（`NoteConflictRecord`）を操作するため、片方で選んだ結果がもう
 * 片方にも正しく反映され、いつでも選び直せる。1件ぶんの表示・選択ロジックは`ConflictItem`
 * として切り出し、履歴タブ側（`HistoryScreen.tsx`）と共有する。
 *
 * 選び直しは `notesRepo.applyConflictResolution()` で行う——上書き前の内容だけでなく、
 * 採用しなかった側の内容も noteHistory に積むため、次回同じ相手と連携しても同じ2版が
 * 再び競合として検出されない（`notes.ts`のコメント参照）。
 *
 * PC版・Android版で表示内容もCSSクラスも同一のため、`src/ui/shared/` に置いて共有する
 * （`MermaidDiagram.tsx` と同じ扱い）。狭幅では2案が縦に折り返る（`.link-conflict-sides`）。
 */
export type ConflictResolution = 'local' | 'remote' | 'merged';

export interface ConflictActionDeps {
  notesRepo: NotesRepository;
  conflictsRepo: NoteConflictsRepository;
  deviceId: string;
  claude: AiClient;
}

export default function ConflictResolver({
  conflicts,
  deps,
}: {
  conflicts: NoteConflictRecord[];
  deps: ConflictActionDeps;
}) {
  const [open, setOpen] = useState(false);

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
      <p className="search-status">
        どちらかを採用するか、2つをAIで統合できます。何もしなければ新しい方（自動採用）のままです。
      </p>
      <p className="search-status">
        ここでの選択はこの端末にのみ反映されます。相手の端末に反映するには、もう一度連携（QR）を行ってください。
        選び直しはあとから履歴画面の「取り込み履歴」タブでもできます。
      </p>
      <ul className="link-conflict-list">
        {conflicts.map((c) => (
          <li key={c.id} className="link-conflict">
            <ConflictItem conflict={c} deps={deps} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 競合1件ぶんの表示・選択。`ConflictResolver`（連携直後）・履歴画面「取り込み履歴」タブの
 * 両方から使う。解決済みでも常に3択（この端末／相手／AI統合）を出し、いつでも選び直せる
 * ——確認ダイアログは挟まず、押した瞬間に`notes`へ反映する（連携直後の操作感を踏襲）。
 */
export function ConflictItem({
  conflict,
  deps,
  onResolved,
}: {
  conflict: NoteConflictRecord;
  deps: ConflictActionDeps;
  onResolved?: (updated: NoteConflictRecord) => void;
}) {
  const [current, setCurrent] = useState(conflict);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

  async function apply(
    body: string,
    diagrams: string[],
    how: ConflictResolution,
    mergedCache: { body: string; diagrams: string[] } | null,
  ) {
    const rejected =
      how === 'remote'
        ? { body: current.local.body, diagrams: current.local.diagrams }
        : { body: current.remote.body, diagrams: current.remote.diagrams };
    const at = Date.now();
    await deps.notesRepo.applyConflictResolution(current.termId, body, diagrams, deps.deviceId, at, rejected);
    await deps.conflictsRepo.setResolution(current.id, how, mergedCache, at);
    const updated: NoteConflictRecord = {
      ...current,
      resolution: how,
      merged: mergedCache ?? current.merged,
      resolvedAt: at,
    };
    setCurrent(updated);
    onResolved?.(updated);
  }

  async function chooseSide(side: 'local' | 'remote') {
    const chosen = side === 'local' ? current.local : current.remote;
    await apply(chosen.body, chosen.diagrams, side, null);
  }

  /**
   * どちらか一方を捨てるのではなく、2つをAIに掛け合わせて1つの説明にまとめる。
   * 1度統合した結果は`current.merged`にキャッシュされているため、選び直しで再度この
   * ボタンを押しても、既にキャッシュがあれば再度AIを呼ばずそのまま採用する。
   */
  async function chooseMerged() {
    if (current.merged) {
      await apply(current.merged.body, current.merged.diagrams, 'merged', current.merged);
      return;
    }
    setMerging(true);
    setMergeError(null);
    try {
      const result = await resolveConflict({ termId: current.termId, local: current.local, remote: current.remote }, deps.claude);
      if (!result) throw new Error('AIの応答を解釈できませんでした。');
      await apply(result.body, result.diagrams, 'merged', result);
    } catch (err) {
      logAiError(`ConflictItem.chooseMerged(${current.termId})`, err);
      setMergeError(err instanceof Error ? err.message : String(err));
    } finally {
      setMerging(false);
    }
  }

  return (
    <>
      <h4 className="link-conflict-term">{current.termId}</h4>
      {current.resolution && (
        <p className="search-status">現在の選択: {describeResolution(current.resolution)}（下からいつでも選び直せます）</p>
      )}
      <div className="link-conflict-sides">
        <ConflictSide
          title="この端末の内容"
          note={current.local}
          selected={current.resolution === 'local'}
          onChoose={() => void chooseSide('local')}
        />
        <ConflictSide
          title="相手の端末の内容"
          note={current.remote}
          selected={current.resolution === 'remote'}
          onChoose={() => void chooseSide('remote')}
        />
      </div>
      <div className="link-conflict-merge">
        <button type="button" className="btn-primary" onClick={() => void chooseMerged()} disabled={merging}>
          {merging ? 'AIが統合しています…' : current.merged ? '統合した内容を採用' : 'AIで統合する'}
        </button>
        <span className="search-status">どちらも捨てずに、AIが1つの説明にまとめます（APIキーが必要です）。</span>
        {mergeError && <p className="chat-error">{mergeError}</p>}
      </div>
    </>
  );
}

function describeResolution(how: ConflictResolution): string {
  if (how === 'merged') return '2つをAIで統合しました。';
  return `${how === 'local' ? 'この端末の内容' : '相手の端末の内容'}にしました。`;
}

function ConflictSide({
  title,
  note,
  selected,
  onChoose,
}: {
  title: string;
  note: NoteRecord;
  selected: boolean;
  onChoose: () => void;
}) {
  return (
    <div className="link-conflict-side">
      <h5 className="link-conflict-side-title">
        {title}
        <span className="search-result-reading">{new Date(note.updatedAt).toLocaleString('ja-JP')}</span>
      </h5>
      <p className="link-conflict-body">{note.body}</p>
      <button type="button" className="btn-secondary" onClick={onChoose}>
        {selected ? 'こちらを採用中' : 'こちらを採用'}
      </button>
    </div>
  );
}
