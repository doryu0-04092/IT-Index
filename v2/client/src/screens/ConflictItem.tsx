import type { NoteConflictRecord } from '../types';

/**
 * 競合1件ぶんの表示・選択(移植元: ../../../src/ui/shared/ConflictResolver.tsx の
 * ConflictItem)。SyncScreenの「未解決の競合」「解決済みの競合(選び直し)」の両方から使う
 * ——v1と同じく、解決済みでも常に3択(自分/相手/AI統合)を出し、押した瞬間にnotesへ反映する
 * (確認ダイアログは挟まない)。v1にあったPC/Android版の`canResolve`分岐はv2には無い
 * (v2は単一のWebクライアントのため、常に選択操作を出す)。
 *
 * ロジック(AI呼び出し・DB反映・一覧再読込)は呼び出し元のSyncScreenが持つ——このコンポーネントは
 * 表示と、渡されたハンドラの呼び出しだけを行う(SyncScreen側の既存のhandleResolveパターンに
 * 合わせるため。v1のように自前でuseStateを持たせると、未解決/解決済み両リストの再読込元と
 * 二重管理になる)。
 */
export interface ConflictItemProps {
  conflict: NoteConflictRecord;
  merging: boolean;
  mergeError: string | null;
  mergeErrorCode: string | null;
  onChooseLocal: () => void;
  onChooseRemote: () => void;
  onMerge: () => void;
  /** license_required時の設定タブ誘導(ChatScreen.tsxと同じ流儀)。未指定ならボタンを出さない */
  onGoToSettings?: () => void;
}

export default function ConflictItem({
  conflict,
  merging,
  mergeError,
  mergeErrorCode,
  onChooseLocal,
  onChooseRemote,
  onMerge,
  onGoToSettings,
}: ConflictItemProps) {
  return (
    <li className="sync-conflict">
      <h4>{conflict.termId}</h4>
      {conflict.resolution && (
        <p className="status-text">
          現在の選択: {describeResolution(conflict.resolution)}(いつでも選び直せます)
        </p>
      )}
      <div className="sync-conflict-sides">
        <div className="sync-conflict-side">
          <p>この端末の内容({new Date(conflict.local.updatedAt).toLocaleString('ja-JP')})</p>
          <p>{conflict.local.body}</p>
          <button type="button" className="btn-secondary" onClick={onChooseLocal}>
            {conflict.resolution === 'local' ? 'こちらを採用中' : 'こちらを採用'}
          </button>
        </div>
        <div className="sync-conflict-side">
          <p>相手の端末の内容({new Date(conflict.remote.updatedAt).toLocaleString('ja-JP')})</p>
          <p>{conflict.remote.body}</p>
          <button type="button" className="btn-secondary" onClick={onChooseRemote}>
            {conflict.resolution === 'remote' ? 'こちらを採用中' : 'こちらを採用'}
          </button>
        </div>
      </div>
      <div className="sync-conflict-merge">
        <button type="button" className="btn-primary" onClick={onMerge} disabled={merging}>
          {merging
            ? 'AIが統合しています…'
            : conflict.resolution === 'merged'
              ? '統合した内容を採用中'
              : conflict.merged
                ? '統合した内容を採用'
                : 'AIで統合する'}
        </button>
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
    </li>
  );
}

function describeResolution(how: 'local' | 'remote' | 'merged'): string {
  if (how === 'merged') return '2つをAIで統合しました。';
  return `${how === 'local' ? 'この端末の内容' : '相手の端末の内容'}にしました。`;
}
