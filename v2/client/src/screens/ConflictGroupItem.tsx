import type { ConflictGroup } from '../sync/groupConflicts';
import { localSideOf, MAX_CONFLICT_DEVICES } from '../sync/groupConflicts';
import type { NoteConflictRecord } from '../types';
import { CONFLICT_PC_ONLY_NOTICE } from './ConflictItem';

/**
 * 同じ単語で複数の端末と競合した場合の表示(#203)。
 *
 * **横2列をやめ、縦一列にする。** 従来の `ConflictItem` は「この端末 / 相手」を横に並べる
 * 作りで、3台以上になると収まらなかった。複数の端末で同じ単語にAI検索を掛け続けると
 * その状態になる(実機で報告された)。
 *
 * **この端末の内容を一番上に固定する**(本人指定)。位置が毎回変わると見比べにくいため。
 * 相手の端末は**ノートの更新が新しい順**で、`MAX_CONFLICT_DEVICES` 台までを出す
 * (落とした分は件数だけ知らせ、履歴タブから辿れる)。
 *
 * ロジック(AI呼び出し・DB反映・一覧再読込)は呼び出し元が持つ——このコンポーネントは
 * 表示と、渡されたハンドラの呼び出しだけを行う(`ConflictItem` と同じ方針)。
 *
 * 履歴タブは従来どおり `ConflictItem`(1対1)を使う——あちらは「いつ何を選んだか」を
 * 1件ずつ辿る場所で、まとめると経緯が読めなくなるため。
 */
export interface ConflictGroupItemProps {
  group: ConflictGroup;
  /** false(Androidネイティブ)なら選択・AI統合の操作を出さず、PC側での解消を案内する */
  canResolve: boolean;
  /** AI統合の実行中の競合ID。押した行だけを「統合しています…」にする */
  mergingId: string | null;
  mergeErrors: Record<string, string | null>;
  mergeErrorCodes: Record<string, string | null>;
  onChooseLocal: (conflict: NoteConflictRecord) => void;
  onChooseRemote: (conflict: NoteConflictRecord) => void;
  onMerge: (conflict: NoteConflictRecord) => void;
  onGoToSettings?: () => void;
}

function formatTime(at: number): string {
  return new Date(at).toLocaleString('ja-JP');
}

export default function ConflictGroupItem({
  group,
  canResolve,
  mergingId,
  mergeErrors,
  mergeErrorCodes,
  onChooseLocal,
  onChooseRemote,
  onMerge,
  onGoToSettings,
}: ConflictGroupItemProps) {
  // どの競合レコードの`local`も同じこの端末の内容だが、検出時刻がずれていれば差がありうる。
  // 最も新しく検出されたものを代表にする
  const representative = localSideOf(group);
  const adoptedLocal = group.conflicts.some((c) => c.resolution === 'local');
  const adoptedBadge = <span className="conflict-adopted-badge">✓ 採用中</span>;

  return (
    <li className="sync-conflict" data-testid={`conflict-group-${group.termId}`}>
      <h4>{group.termId}</h4>
      <p className="status-text">
        {group.conflicts.length}台の端末と内容が食い違っています
        {group.hiddenCount > 0 && `(ほか${group.hiddenCount}台は履歴タブで確認できます)`}
      </p>

      {/* 縦一列。1番目が常にこの端末で、以降が相手端末(更新が新しい順) */}
      <ol className="conflict-device-list">
        <li className={`sync-conflict-side${adoptedLocal ? ' conflict-adopted' : ''}`}>
          <p className="sync-conflict-side-title">
            この端末の内容({formatTime(representative.local.updatedAt)})
            {adoptedLocal && adoptedBadge}
          </p>
          <p>{representative.local.body}</p>
          {canResolve && !adoptedLocal && (
            <button type="button" className="btn-secondary" onClick={() => onChooseLocal(representative)}>
              こちらを採用
            </button>
          )}
        </li>

        {group.conflicts.map((conflict) => {
          const closed = conflict.closedReason !== null;
          const interactive = canResolve && !closed;
          const adopted = conflict.resolution === 'remote';
          const merging = mergingId === conflict.id;
          const mergeError = mergeErrors[conflict.id] ?? null;
          const mergeErrorCode = mergeErrorCodes[conflict.id] ?? null;

          return (
            <li
              key={conflict.id}
              className={`sync-conflict-side${adopted ? ' conflict-adopted' : ''}`}
              data-testid={`conflict-device-${conflict.peerDeviceId}`}
            >
              <p className="sync-conflict-side-title">
                別の端末の内容({formatTime(conflict.remote.updatedAt)})
                {adopted && adoptedBadge}
              </p>
              <p>{conflict.remote.body}</p>

              {conflict.resolution === 'merged' && conflict.merged && (
                <div className="sync-conflict-merged-preview">
                  <p className="sync-conflict-side-title">AIで統合した内容{adoptedBadge}</p>
                  <p>{conflict.merged.body}</p>
                </div>
              )}

              {interactive && (
                <div className="conflict-device-actions">
                  {!adopted && (
                    <button type="button" className="btn-secondary" onClick={() => onChooseRemote(conflict)}>
                      こちらを採用
                    </button>
                  )}
                  {conflict.resolution !== 'merged' && (
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={() => onMerge(conflict)}
                      disabled={merging}
                    >
                      {merging ? 'AIが統合しています…' : conflict.merged ? '統合した内容を採用' : 'この端末とAIで統合'}
                    </button>
                  )}
                </div>
              )}

              {mergeError && mergeErrorCode !== 'license_required' && (
                <p className="error-text">{mergeError}</p>
              )}
              {mergeErrorCode === 'license_required' && onGoToSettings && (
                <div className="chat-license-required">
                  <p className="error-text">{mergeError}</p>
                  <button type="button" className="btn-secondary" onClick={onGoToSettings}>
                    設定タブへ
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {!canResolve && <p className="status-text conflict-pc-only-notice">{CONFLICT_PC_ONLY_NOTICE}</p>}
    </li>
  );
}

/** 上限の値を画面外(テスト等)から参照するための再輸出 */
export { MAX_CONFLICT_DEVICES };
