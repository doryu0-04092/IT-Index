import type { NoteConflictRecord } from '../types';

/**
 * 競合1件ぶんの表示・選択(移植元: ../../../src/ui/shared/ConflictResolver.tsx の
 * ConflictItem)。同期タブと履歴タブの競合一覧の両方から使う——v1と同じく、解決済みでも
 * 3択(自分/相手/AI統合)から選び直せ、押した瞬間にnotesへ反映する(確認ダイアログは挟まない)。
 *
 * v1にあった`canResolve`分岐を#157で復活させた: 競合の決着をつける場所をPC側に一本化する
 * (canResolve=false=Androidネイティブでは案内のみ表示。決着をつける場所が分散すると
 * 収束しない——v1 docs/ui-pc.md §「競合選択」と同じ理由)。
 *
 * 採用中の選択肢はバッジ(✓ 採用中)とカードの強調で明示する(#157依頼者指定。
 * ボタン文言の差だけでは見分けにくかった)。
 *
 * ロジック(AI呼び出し・DB反映・一覧再読込)は呼び出し元(sync/useConflictResolution.ts)が
 * 持つ——このコンポーネントは表示と、渡されたハンドラの呼び出しだけを行う。
 */
export interface ConflictItemProps {
  conflict: NoteConflictRecord;
  /** false(Androidネイティブ)なら選択・AI統合の操作を出さず、PC側での解消を案内する */
  canResolve: boolean;
  merging: boolean;
  mergeError: string | null;
  mergeErrorCode: string | null;
  onChooseLocal: () => void;
  onChooseRemote: () => void;
  onMerge: () => void;
  /** license_required時の設定タブ誘導(ChatScreen.tsxと同じ流儀)。未指定ならボタンを出さない */
  onGoToSettings?: () => void;
}

/** Androidネイティブ向けの案内(#157依頼者指定の文言) */
export const CONFLICT_PC_ONLY_NOTICE =
  '競合の解消はパソコン側で行ってください。この端末では、この端末で保存した内容をそのまま表示し続けます。' +
  'パソコン側で解消すると、次の同期でパソコン側と同じ内容に統一されます。';

export default function ConflictItem({
  conflict,
  canResolve,
  merging,
  mergeError,
  mergeErrorCode,
  onChooseLocal,
  onChooseRemote,
  onMerge,
  onGoToSettings,
}: ConflictItemProps) {
  // 自動クローズ済み(peer-decision/superseded)は選び直しの対象にしない——どちらも
  // 「両端末の内容が既に統一された」状態で、ここから選び直すと再び食い違いを作ってしまう
  const closed = conflict.closedReason !== null;
  const interactive = canResolve && !closed;
  const adoptedBadge = <span className="conflict-adopted-badge">✓ 採用中</span>;

  return (
    <li className="sync-conflict">
      <h4>{conflict.termId}</h4>
      {closed && <p className="status-text">{describeClosed(conflict.closedReason!)}</p>}
      {!closed && conflict.resolution && canResolve && (
        <p className="status-text">現在の選択: {describeResolution(conflict.resolution)}(いつでも選び直せます)</p>
      )}

      <div className="sync-conflict-sides">
        <div className={`sync-conflict-side${conflict.resolution === 'local' ? ' conflict-adopted' : ''}`}>
          <p className="sync-conflict-side-title">
            この端末の内容({new Date(conflict.local.updatedAt).toLocaleString('ja-JP')})
            {conflict.resolution === 'local' && adoptedBadge}
          </p>
          <p>{conflict.local.body}</p>
          {interactive && conflict.resolution !== 'local' && (
            <button type="button" className="btn-secondary" onClick={onChooseLocal}>
              こちらを採用
            </button>
          )}
        </div>
        <div className={`sync-conflict-side${conflict.resolution === 'remote' ? ' conflict-adopted' : ''}`}>
          <p className="sync-conflict-side-title">
            相手の端末の内容({new Date(conflict.remote.updatedAt).toLocaleString('ja-JP')})
            {conflict.resolution === 'remote' && adoptedBadge}
          </p>
          <p>{conflict.remote.body}</p>
          {interactive && conflict.resolution !== 'remote' && (
            <button type="button" className="btn-secondary" onClick={onChooseRemote}>
              こちらを採用
            </button>
          )}
        </div>
      </div>

      {/* AI統合を採用中の場合は、採用されている統合結果そのものを見せる——
          「統合した内容を採用中」の文言だけでは何が採用されたのか分からないため(#157) */}
      {conflict.resolution === 'merged' && conflict.merged && (
        <div className="sync-conflict-side conflict-adopted sync-conflict-merged-preview">
          <p className="sync-conflict-side-title">
            AIで統合した内容
            {adoptedBadge}
          </p>
          <p>{conflict.merged.body}</p>
        </div>
      )}

      {interactive ? (
        <div className="sync-conflict-merge">
          {conflict.resolution !== 'merged' && (
            <button type="button" className="btn-primary" onClick={onMerge} disabled={merging}>
              {merging ? 'AIが統合しています…' : conflict.merged ? '統合した内容を採用' : 'AIで統合する'}
            </button>
          )}
          <span className="status-text">どちらも捨てずに、AIが1つの説明にまとめます。</span>
          {mergeError && mergeErrorCode !== 'license_required' && <p className="error-text">{mergeError}</p>}
          {mergeErrorCode === 'license_required' && onGoToSettings && (
            <div className="chat-license-required">
              <p className="error-text">{mergeError}</p>
              <button type="button" className="btn-secondary" onClick={onGoToSettings}>
                設定タブへ
              </button>
            </div>
          )}
        </div>
      ) : (
        !closed && <p className="status-text conflict-pc-only-notice">{CONFLICT_PC_ONLY_NOTICE}</p>
      )}
    </li>
  );
}

function describeResolution(how: 'local' | 'remote' | 'merged'): string {
  if (how === 'merged') return '2つをAIで統合しました。';
  return `${how === 'local' ? 'この端末の内容' : '相手の端末の内容'}にしました。`;
}

function describeClosed(reason: 'peer-decision' | 'superseded'): string {
  if (reason === 'peer-decision') return 'パソコン側の解消結果に統一済みです。';
  return '解消済みです(次の同期で競合が再発しませんでした)。';
}
