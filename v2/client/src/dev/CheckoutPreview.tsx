/**
 * チェックアウト画面のdev限定単体プレビュー。`npm run dev`起動中に
 * `http://localhost:5173/?preview=checkout` で、アプリ本体・サーバー・ログインなしに
 * CheckoutScreenだけを描画する(UI確認用。本人指定「まずUIだけブラウザで見せる」)。
 *
 * main.tsxの分岐はimport.meta.env.DEVガード+動的importのため、本番ビルドでは
 * このファイルごとバンドルから消える。
 *
 * 追加クエリで決済結果を切り替えられる:
 * - (なし)               … 1.2秒後に成功し、ダミーのライセンスコードを表示
 * - &result=already      … 409相当(license_already_active)
 * - &result=fail         … ネットワークエラー相当
 */
import '../App.css';
import CheckoutScreen from '../screens/CheckoutScreen';
import { ApiRequestError } from '../sync/apiClient';

export default function CheckoutPreview() {
  const result = new URLSearchParams(window.location.search).get('result');

  async function processPayment(): Promise<{ code: string; activatedAt: number }> {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    if (result === 'already') {
      throw new ApiRequestError({ code: 'license_already_active', message: '既にライセンスがあります' }, 409);
    }
    if (result === 'fail') {
      throw new ApiRequestError({ code: 'network_error', message: 'サーバーに接続できませんでした' }, 0);
    }
    return { code: 'ITX-DEMO-1234-5678', activatedAt: Date.now() };
  }

  return (
    <div className="app app-checkout-mode">
      <main className="app-main">
        <CheckoutScreen
          onBack={() => window.alert('戻る(プレビュー): 実装後は設定タブへ戻ります')}
          processPayment={processPayment}
        />
      </main>
    </div>
  );
}
