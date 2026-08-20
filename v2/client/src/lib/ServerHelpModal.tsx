/**
 * 「接続先サーバーとは」の説明(#163。要件定義書§4「提供形態」)。ライセンスのヘルプ
 * (LicenseHelpModal, #151)と同じ方式: 設定タブの見出し行のヘルプボタンから開く。
 * URLの入力欄だけでは「何のための設定か・いつ変更するものか」が分からなかったため追加する。
 * 記載は要件定義書§4に定義済みの内容のみで、実装されていない機能は書かない。
 */
export interface ServerHelpModalProps {
  onClose: () => void;
}

export default function ServerHelpModal({ onClose }: ServerHelpModalProps) {
  return (
    <div className="modal-overlay">
      <div className="modal-content" role="dialog" aria-modal="true" aria-labelledby="server-help-title">
        <div className="modal-header">
          <h2 id="server-help-title">接続先サーバーとは</h2>
          <button type="button" className="dismiss-error" onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        </div>

        <p className="status-text">
          アカウント・端末間同期の中継・APIキーなしでのAI利用・ライセンスの管理を担うサーバーです。
          既定は<strong>公式サーバー</strong>(https://it-index.doryu.workers.dev、Cloudflare上で運用)に
          接続します。<strong>通常は変更不要です。</strong>
        </p>
        <ul className="premium-benefits">
          <li>
            <strong>変更するのは、自分でサーバーを立てた場合(セルフホスト)だけ</strong>です。
            自分のCloudflareアカウントに同じサーバーを立て(手順はリポジトリのdocs/v2/deploy.md)、
            そのURLをここに設定すると、同期とAI中継が<strong>ライセンス不要</strong>で動きます
            (運用・費用は自分持ちになります)
          </li>
          <li>
            <strong>検索・索引・履歴・ノートなどの辞書機能は、サーバーに接続しなくても動きます</strong>
            (止まるのは同期とAIだけです)
          </li>
        </ul>
        <p className="status-text-small">
          入力したURLは接続テストに成功した場合だけ保存されます。「既定に戻す」でいつでも公式サーバーに戻せます。
        </p>

        <button type="button" className="btn-secondary" onClick={onClose}>
          閉じる
        </button>
      </div>
    </div>
  );
}
