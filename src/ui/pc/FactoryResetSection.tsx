import { useState } from 'react';
import { factoryReset } from '../../factoryReset';

const CONFIRM_TEXT = '初期化する';

/**
 * 設定モーダルの「オールクリア」セクション。ローカルデータの初期化（LocalFolderPanelの
 * 「初期データに戻す」、ローカルフォルダ連携が前提）とは別物で、フォルダ連携の有無に
 * 関わらず常に使える。用語・履歴・APIキー・テーマ設定まで含め初回起動時の状態に戻す、
 * より広範囲かつ取り消せない操作のため、確認文字列を入力しないと実行できないようにする
 * （通常のconfirm()一発では誤操作を防げないという要望による）。
 */
export default function FactoryResetSection() {
  const [expanded, setExpanded] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleCancel() {
    setExpanded(false);
    setConfirmText('');
    setError(null);
  }

  async function handleExecute() {
    if (confirmText !== CONFIRM_TEXT) return;
    setBusy(true);
    setError(null);
    try {
      await factoryReset();
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <section className="settings-section settings-section-danger">
      <h3>オールクリア</h3>
      <p className="search-status">
        用語・ノート・検索履歴・APIキー・ローカルフォルダ連携・テーマ設定など、このアプリが保存している全てのデータを削除し、初回起動時と同じ状態に戻します。
        <strong>この操作は取り消せません。</strong>
        （WebAuthnのパスキー登録自体はブラウザ・OS側の管轄のため削除されません）
      </p>
      {!expanded ? (
        <button type="button" className="btn-secondary" onClick={() => setExpanded(true)}>
          オールクリアする
        </button>
      ) : (
        <div className="factory-reset-confirm">
          <p className="search-status">
            実行するには下の欄に「{CONFIRM_TEXT}」と入力してください。
          </p>
          <input
            type="text"
            className="search-input"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={CONFIRM_TEXT}
            disabled={busy}
          />
          <div className="api-key-actions">
            <button
              type="button"
              className="btn-primary"
              onClick={() => void handleExecute()}
              disabled={confirmText !== CONFIRM_TEXT || busy}
            >
              {busy ? '実行中…' : '実行する'}
            </button>
            <button type="button" className="btn-text" onClick={handleCancel} disabled={busy}>
              キャンセル
            </button>
          </div>
          {error && <p className="chat-error">初期化に失敗しました: {error}</p>}
        </div>
      )}
    </section>
  );
}
