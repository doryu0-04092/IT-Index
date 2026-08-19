/**
 * 「IT-Index プレミアムとは」の説明(要件定義書§4「提供形態」)。購入導線のどこにも
 * 「これが月額制サブスクである」「購入すると何ができるか」の説明が無く、利用者が
 * 内容を知らないままカード入力に進んでいた(#151)ため、購入前の2箇所に説明を出す:
 * - 設定タブのライセンス欄のヘルプ → このモーダル(LicenseHelpModal)
 * - チェックアウトの説明ステップ(CheckoutScreen.tsx) → PremiumBenefits を埋め込み
 *
 * 特典の文言は PremiumBenefits の1箇所に集約し、2画面で重複定義しない。
 * 記載するのは要件定義書§4で定義済みの2機能のみで、実装されていない特典は書かない。
 */

/**
 * 購入で使えるようになる機能の一覧と「無料のまま使える範囲」の注記。
 * モーダルとチェックアウトの説明ステップで共有する。
 */
export function PremiumBenefits() {
  return (
    <>
      <ul className="premium-benefits">
        <li>
          <strong>端末間同期</strong> — 単語帳・ノート・履歴を複数の端末で揃えられます
          (Android含む。同じネットワークにいなくても同期できます)
        </li>
        <li>
          <strong>APIキーなしでのAI利用</strong> — 自分のAPIキーを登録しなくてもAIに質問できます
          (1日の回数上限あり)
        </li>
      </ul>
      <p className="status-text-small">
        検索・索引・履歴・ノートなどの辞書機能は、これまでどおり無料で使えます
      </p>
    </>
  );
}

export interface LicenseHelpModalProps {
  onClose: () => void;
}

/** 設定タブのライセンス欄から開く説明ウィンドウ。表示のみで状態は持たない。 */
export default function LicenseHelpModal({ onClose }: LicenseHelpModalProps) {
  return (
    <div className="modal-overlay">
      <div className="modal-content" role="dialog" aria-modal="true" aria-labelledby="license-help-title">
        <div className="modal-header">
          <h2 id="license-help-title">IT-Index プレミアムとは</h2>
          <button type="button" className="dismiss-error" onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        </div>

        <p className="status-text">
          <strong>月額制のサブスクリプション</strong>(¥300/月・毎月自動更新)です。
          購入すると次の機能が使えるようになります。
        </p>
        <PremiumBenefits />
        <p className="status-text-small">
          解約はいつでもできます。設定タブ最下部の「解約」から実行でき、即時に反映されます。
        </p>
        <p className="status-text-small">モック決済のため、実際の課金は発生しません</p>

        <button type="button" className="btn-secondary" onClick={onClose}>
          閉じる
        </button>
      </div>
    </div>
  );
}
