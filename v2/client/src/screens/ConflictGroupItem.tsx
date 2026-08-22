import type { ConflictGroup } from '../sync/groupConflicts';
import { localSideOf, MAX_CONFLICT_DEVICES } from '../sync/groupConflicts';
import type { NoteConflictRecord } from '../types';
/**
 * Androidネイティブで解消操作を出さない時の案内(#165)。
 * 競合の表示は本コンポーネントに一本化したため、文言もここに置く(#225)。
 */
export const CONFLICT_PC_ONLY_NOTICE =
  '解消はパソコン側で行ってください。それまでこの端末では、この端末で保存した内容を表示します。' +
  'パソコン側で解消すると、次の同期で同じ内容に統一されます。';

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
  /**
   * この語の競合を**まとめて**AIで統一する(#238)。相手ごとに統合すると情報が薄まり、
   * 決定が分裂して相手端末が収束しないため、渡すのは未解決の競合**全件**。
   */
  onMergeAll: (conflicts: NoteConflictRecord[]) => void;
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
  onMergeAll,
  onGoToSettings,
}: ConflictGroupItemProps) {
  // どの競合レコードの`local`も同じこの端末の内容だが、検出時刻がずれていれば差がありうる。
  // 最も新しく検出されたものを代表にする
  const representative = localSideOf(group);
  /*
   * **「採用中」はグループに1つだけ(#242)。**
   *
   * 競合レコードは相手端末ごとに1件ずつある(#224)が、**ノートは1語に1つしか無い**。
   * レコードごとにバッジを出していたため、別々の解消結果が入っていると
   * 「AIで統合した内容」と「別の端末の内容」の両方に採用中が付き、いまノートに
   * 入っているのがどれか画面から判断できなかった(実機で報告された)。
   *
   * **最後に解消したものが、いまの内容。** resolvedAt が最大のレコードを見る。
   */
  const currentChoice = group.conflicts
    .filter((c) => c.resolution !== null && c.resolvedAt !== null)
    .reduce<NoteConflictRecord | null>(
      (latest, c) => (latest === null || (c.resolvedAt ?? 0) > (latest.resolvedAt ?? 0) ? c : latest),
      null,
    );
  const adoptedLocal = currentChoice?.resolution === 'local';
  // 履歴タブでは決着済みの競合も同じ形で並べる(#225)。見出しはその区別に使う
  const openCount = group.conflicts.filter((c) => c.resolution === null && c.closedReason === null).length;
  /*
   * 「この端末の内容」側の操作可否は**グループ単位**で決まる(相手側は競合ごと)。
   * 'peer-decision'(AndroidがPCの決定を採用した記録)しか無いグループでは、
   * こちら側にも採用ボタンを出さない——出すと相手側だけ操作不可という
   * ちぐはぐな状態になり、押しても解消をPC側へ集約する設計(#157/#165)に反する。
   */
  /** 解消できる競合。'peer-decision'(相手の決定を採用した記録)だけ対象外(#157/#165) */
  const resolvable = group.conflicts.filter((c) => c.closedReason !== 'peer-decision');

  // 統合はグループ単位(#238)。状態も語(termId)をキーに持つ
  const merging = mergingId === group.termId;
  const mergeError = mergeErrors[group.termId] ?? null;
  const mergeErrorCode = mergeErrorCodes[group.termId] ?? null;
  /*
   * **統合の対象は「解消できる競合」全部(#246)。**
   *
   * #238で「未解決があるとき」に狭めたため、**どれかを採用した瞬間にボタンが消えていた**。
   * 競合履歴に出るのは決着済みが中心なので、履歴タブではほぼ常に出なかった。
   * 「一度どれかを採用したが、あとで全部まとめたい」ができなくなる。
   *
   * 対象外は 'peer-decision'(相手の決定を採用した記録)だけ——解消をPC側へ集約する
   * 設計(#157/#165)は変えない。
   */
  const mergeTargets = resolvable;
  /**
   * **統合が済んだら、ボタンは「統合した内容を採用」に変わる(v1と同じ形。本人指定)。**
   * キャッシュがある間はAIを二度と呼ばない——元の内容へ選び直しても、このボタンから
   * いつでも統合結果へ戻せる。「AIで統合」へ戻るのは、新しい端末との競合が増えて
   * キャッシュにその端末の情報が無い時だけ(sharedMergedCacheが弾く)。
   */
  const hasCachedMerge = sharedMergedCache(mergeTargets) !== null;

  const localTarget = resolvable.length > 0
    ? resolvable.reduce((newest, c) => (c.detectedAt > newest.detectedAt ? c : newest))
    : undefined;
  const adoptedBadge = <span className="conflict-adopted-badge">✓ 採用中</span>;

  return (
    <li className="sync-conflict" data-testid={`conflict-group-${group.termId}`}>
      <h4>{group.termId}</h4>
<p className="status-text">
        {openCount > 0
          ? `${openCount}台の端末と内容が食い違っています`
          : `${group.conflicts.length}台の端末との競合は決着しています`}
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
          {canResolve && !adoptedLocal && localTarget && (
            <button type="button" className="btn-secondary" onClick={() => onChooseLocal(localTarget)}>
              こちらを採用
            </button>
          )}
        </li>

        {group.conflicts.map((conflict) => {
          // 自動で閉じた競合も選び直せる(#224)。'peer-decision' だけは対象外
          const interactive = canResolve && conflict.closedReason !== 'peer-decision';
          // バッジは「いまの選択」の1件だけ(#242)
          const adopted = currentChoice?.id === conflict.id && conflict.resolution === 'remote';

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

              {conflict.closedReason !== null && (
                <p className="status-text">{describeClosed(conflict.closedReason)}</p>
              )}

              {interactive && !adopted && (
                <div className="conflict-device-actions">
                  <button type="button" className="btn-secondary" onClick={() => onChooseRemote(conflict)}>
                    こちらを採用
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {currentChoice?.resolution === 'merged' && currentChoice.merged && (
        /* 統合結果は全レコード共通なので、グループに1回だけ出す(#242) */
        <div className="sync-conflict-merged-preview">
          <p className="sync-conflict-side-title">AIで統合した内容{adoptedBadge}</p>
          <p>{currentChoice.merged.body}</p>
        </div>
      )}

      {currentChoice !== null && currentChoice.closedReason === null && canResolve && (
        <p className="status-text">
          現在の選択: {describeResolution(currentChoice.resolution!)}(いつでも選び直せます)
        </p>
      )}

      {canResolve && mergeTargets.length > 0 && (
        /*
         * **統合はこの語ぜんぶを1回で(#238)。** 相手ごとに統合すると、1回目の結果を
         * 2回目でもう一度AIに通すことになり要約の要約で情報が薄まるうえ、決定が
         * 複数回に分かれて相手端末が収束しない(実機で報告された)。
         */
        <div className="conflict-group-actions">
          <button
            type="button"
            className="btn-primary"
            onClick={() => onMergeAll(mergeTargets)}
            disabled={merging}
          >
            {merging
              ? 'AIが統合しています…'
              : hasCachedMerge
                ? '統合した内容を採用'
                : `すべての端末の内容をAIで統合(${mergeTargets.length + 1}件)`}
          </button>
          {!hasCachedMerge && (
            <p className="status-text-small">
              この端末と相手{mergeTargets.length}台の内容を、1回の処理で1つにまとめます。
            </p>
          )}
        </div>
      )}

      {mergeError && mergeErrorCode !== 'license_required' && <p className="error-text">{mergeError}</p>}
      {mergeErrorCode === 'license_required' && onGoToSettings && (
        <div className="chat-license-required">
          <p className="error-text">{mergeError}</p>
          <button type="button" className="btn-secondary" onClick={onGoToSettings}>
            設定タブへ
          </button>
        </div>
      )}

      {!canResolve && <p className="status-text conflict-pc-only-notice">{CONFLICT_PC_ONLY_NOTICE}</p>}
    </li>
  );
}

/**
 * 対象全件が同じ統合結果を持っていればそれを返す(#238)。1件でも欠けていれば null——
 * その相手の情報が入っていない古い結果なので、作り直す必要がある。
 */
function sharedMergedCache(conflicts: NoteConflictRecord[]): { body: string; diagrams: string[] } | null {
  if (conflicts.length === 0) return null;
  const first = conflicts[0].merged;
  if (first === null) return null;
  return conflicts.every((c) => c.merged !== null && c.merged.body === first.body) ? first : null;
}

function describeResolution(how: 'local' | 'remote' | 'merged'): string {
  if (how === 'merged') return 'AIで統合した内容';
  return `${how === 'local' ? 'この端末の内容' : '相手の端末の内容'}にしました。`;
}

function describeClosed(reason: 'peer-decision' | 'converged' | 'superseded'): string {
  if (reason === 'peer-decision') return 'パソコン側の解消結果に統一済みです。';
  // 'superseded' は #224 以前の自動クローズ。既存の記録が残るため文言を維持する
  if (reason === 'superseded') return '解消済みです(次の同期で競合が再発しませんでした)。';
  return '相手の端末と同じ内容になったため決着しました。';
}

/** 上限の値を画面外(テスト等)から参照するための再輸出 */
export { MAX_CONFLICT_DEVICES };
