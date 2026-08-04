import { useState } from 'react';
import type { AiClient } from '../../ai/aiClient';
import { logAiError } from '../../ai/logError';
import type { NoteConflict } from '../../core/mergeSnapshot';
import type { ManualSyncDeps } from '../../manualSync/sync';
import { resolveConflict } from '../../sync/resolveConflict';
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
type Resolution = 'local' | 'remote' | 'merged';

export default function ConflictResolver({
  conflicts,
  deps,
  claude,
}: {
  conflicts: NoteConflict[];
  deps: ManualSyncDeps;
  claude: AiClient;
}) {
  const [open, setOpen] = useState(false);
  const [resolved, setResolved] = useState<Record<string, Resolution>>({});
  const [merging, setMerging] = useState<string | null>(null);
  const [mergeError, setMergeError] = useState<Record<string, string>>({});

  async function apply(termId: string, body: string, diagrams: string[], how: Resolution) {
    await deps.notesRepo.applyCommit(termId, body, diagrams, deps.deviceId, Date.now());
    setResolved((prev) => ({ ...prev, [termId]: how }));
  }

  async function choose(conflict: NoteConflict, side: 'local' | 'remote') {
    const chosen = side === 'local' ? conflict.local : conflict.remote;
    await apply(conflict.termId, chosen.body, chosen.diagrams, side);
  }

  /**
   * どちらか一方を捨てるのではなく、2つをAIに掛け合わせて1つの説明にまとめる。
   * 使うプロンプトは取り込み時の育成統合と同じ `MERGE_SYSTEM_PROMPT`
   * （「既存の情報を勝手に削らない・重複整理のみ・要約して薄めない」の制約付き）なので、
   * どちらかの内容が一方的に落ちることは無い。APIキーが未設定なら送信時に失敗するため、
   * その旨をこの語の行に出す（画面全体を止めない）。
   */
  async function mergeWithAi(conflict: NoteConflict) {
    setMerging(conflict.termId);
    setMergeError((prev) => {
      const next = { ...prev };
      delete next[conflict.termId];
      return next;
    });
    try {
      const result = await resolveConflict(conflict, claude);
      if (!result) throw new Error('AIの応答を解釈できませんでした。');
      await apply(conflict.termId, result.body, result.diagrams, 'merged');
    } catch (err) {
      logAiError(`ConflictResolver.mergeWithAi(${conflict.termId})`, err);
      setMergeError((prev) => ({ ...prev, [conflict.termId]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setMerging(null);
    }
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
      <p className="search-status">
        どちらかを採用するか、2つをAIで統合できます。何もしなければ新しい方（自動採用）のままです。
      </p>
      <ul className="link-conflict-list">
        {conflicts.map((c) => (
          <li key={c.termId} className="link-conflict">
            <h4 className="link-conflict-term">{c.termId}</h4>
            {resolved[c.termId] ? (
              <p className="search-status">{describeResolution(resolved[c.termId])}</p>
            ) : (
              <>
                <div className="link-conflict-sides">
                  <ConflictSide title="この端末の内容" note={c.local} onChoose={() => void choose(c, 'local')} />
                  <ConflictSide title="相手の端末の内容" note={c.remote} onChoose={() => void choose(c, 'remote')} />
                </div>
                <div className="link-conflict-merge">
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => void mergeWithAi(c)}
                    disabled={merging !== null}
                  >
                    {merging === c.termId ? 'AIが統合しています…' : '2つをAIで統合する'}
                  </button>
                  <span className="search-status">
                    どちらも捨てずに、AIが1つの説明にまとめます（APIキーが必要です）。
                  </span>
                  {mergeError[c.termId] && <p className="chat-error">{mergeError[c.termId]}</p>}
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function describeResolution(how: Resolution): string {
  if (how === 'merged') return '2つをAIで統合しました。';
  return `${how === 'local' ? 'この端末の内容' : '相手の端末の内容'}にしました。`;
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
