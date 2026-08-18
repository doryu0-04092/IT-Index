/**
 * チェックアウト画面(要件定義書§4.2「決済はモック」)。設定タブから遷移する全画面の
 * クレジットカード入力フォーム(本人指定: Stripe Checkout風・全画面形式)。用途は2つ:
 * - intent='purchase': ライセンス購入。成功時はprocessPaymentが返したライセンスコードを表示し、
 *   お支払い方法(ブランド・下4桁など表示用の4項目)をsavePaymentMethodでサーバーへ保存する。
 * - intent='change-card': お支払い方法の変更。課金処理(processPayment)は呼ばず、
 *   savePaymentMethodだけを呼ぶ(モックのため実際の請求先変更は発生しない)。
 *
 * **完全なカード番号とCVCはどこにも送らないし保存もしない**。番号はブランド判定と下4桁の
 * 取得にだけ使い、検証はlib/cardValidation.tsの純関数でフロント側で完結する。
 * 一方、表示用の4項目はアカウントに属するデータとしてサーバーが持つ(migrations/0004)——
 * 端末内保存だけだと、購入した端末以外で「ライセンス有効なのにカード未登録」という
 * 矛盾表示になっていたため。
 *
 * 「支払い」と「カード保存」の実体はpropに委譲する——本番はApp.tsxがpurchaseLicense(token)と
 * savePaymentMethod(token, …)を渡し、devプレビュー(dev/CheckoutPreview.tsx)とテストは
 * モックを渡す。この分離により、画面側はAPIの契約だけを知っていればよい。
 */
import { useState } from 'react';
import { ApiRequestError, type PaymentMethod } from '../sync/apiClient';
import {
  brandLabel,
  detectBrand,
  formatCardNumber,
  formatExpiry,
  normalizeCardNumber,
  validateCardNumber,
  validateCvc,
  validateExpiry,
} from '../lib/cardValidation';

export interface CheckoutScreenProps {
  /** 'purchase'=ライセンス購入(課金モックあり)、'change-card'=お支払い方法の変更のみ */
  intent: 'purchase' | 'change-card';
  /** 「戻る」「設定へ戻る」で呼ぶ。戻り先は常に設定タブ(入口が設定タブのみのためreturnToは持たない) */
  onBack: () => void;
  /** 決済処理の実体(intent='purchase'でのみ呼ばれる)。本番はApp.tsxがpurchaseLicense(token)を渡す */
  processPayment: () => Promise<{ code: string; activatedAt: number }>;
  /** お支払い方法(表示用4項目)のサーバー保存。両intentで呼ばれる */
  savePaymentMethod: (method: PaymentMethod) => Promise<void>;
  /**
   * 処理中演出の最低表示時間(ms)。既定1500。APIが速く返っても「処理しています」を
   * 一瞬で消さないための演出用で、テストは0を渡してタイマー依存を消す。
   */
  processingMinDelayMs?: number;
}

type Step =
  | { kind: 'form' }
  | { kind: 'processing' }
  | { kind: 'complete'; code: string }
  | { kind: 'card-changed' }
  | { kind: 'already-active' };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function CheckoutScreen({
  intent,
  onBack,
  processPayment,
  savePaymentMethod,
  processingMinDelayMs = 1500,
}: CheckoutScreenProps) {
  const [step, setStep] = useState<Step>({ kind: 'form' });
  const [cardNumber, setCardNumber] = useState('');
  const [expiry, setExpiry] = useState('');
  const [cvc, setCvc] = useState('');
  const [holderName, setHolderName] = useState('');
  /** blur済みフィールドだけエラーを出す(入力途中に「正しくありません」と言わないため) */
  const [touched, setTouched] = useState({ card: false, expiry: false, cvc: false, name: false });
  const [submitError, setSubmitError] = useState<string | null>(null);

  const cardDigits = cardNumber.replace(/\D/g, '');
  const brand = detectBrand(cardDigits);
  const cardValid = validateCardNumber(cardDigits);
  const expiryValid = validateExpiry(expiry);
  const cvcValid = validateCvc(cvc, brand);
  const nameValid = holderName.trim() !== '';
  const allValid = cardValid && expiryValid && cvcValid && nameValid;

  /** 検証済みの入力を保存の形にする(完全な番号・CVCは含めない) */
  function enteredPaymentMethod(): PaymentMethod {
    return { brand, last4: cardDigits.slice(-4), expiry, holderName: holderName.trim() };
  }

  /** 保存に失敗したらフォームへ戻してエラーを出す(成功したことにしない) */
  function failToForm(err: unknown) {
    setStep({ kind: 'form' });
    setSubmitError(err instanceof ApiRequestError ? err.message : 'サーバーに接続できませんでした');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!allValid || step.kind !== 'form') return;
    setSubmitError(null);
    setStep({ kind: 'processing' });

    if (intent === 'change-card') {
      // モックのため課金処理は無し。カードの保存だけを行う
      try {
        await Promise.all([savePaymentMethod(enteredPaymentMethod()), delay(processingMinDelayMs)]);
        setStep({ kind: 'card-changed' });
      } catch (err) {
        failToForm(err);
      }
      return;
    }

    try {
      const [result] = await Promise.all([processPayment(), delay(processingMinDelayMs)]);
      // 決済成功後のカード保存。ここで失敗してもライセンスは発行済みなので、購入自体は
      // 完了として扱い(コードを見せないと利用者が損をする)、カード欄は設定タブの
      // 「カードを登録する」から入れ直せる。
      await savePaymentMethod(enteredPaymentMethod()).catch(() => undefined);
      setStep({ kind: 'complete', code: result.code });
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'license_already_active') {
        setStep({ kind: 'already-active' });
        return;
      }
      failToForm(err);
    }
  }

  if (step.kind === 'processing') {
    return (
      <section className="checkout-screen">
        <div className="checkout-panel checkout-processing" role="status">
          <span className="checkout-spinner" aria-hidden="true" />
          <p>{intent === 'change-card' ? 'お支払い方法を変更しています…' : '決済を処理しています…'}</p>
          <p className="status-text-small">モック決済です。実際の課金は発生しません</p>
        </div>
      </section>
    );
  }

  if (step.kind === 'complete') {
    return (
      <section className="checkout-screen">
        <div className="checkout-panel checkout-complete">
          <CompleteIcon />
          <h2>お支払いが完了しました</h2>
          <p>
            ライセンスコード:{' '}
            <code className="license-code" data-testid="license-code">
              {step.code}
            </code>
          </p>
          <p className="status-text-small">
            ライセンスコードとお支払い方法は設定タブの「ライセンス」からいつでも確認できます
          </p>
          <p className="status-text-small">モック決済のため、実際の課金は発生していません</p>
          <button type="button" className="btn-primary" onClick={onBack}>
            設定へ戻る
          </button>
        </div>
      </section>
    );
  }

  if (step.kind === 'card-changed') {
    return (
      <section className="checkout-screen">
        <div className="checkout-panel checkout-complete">
          <CompleteIcon />
          <h2>お支払い方法を変更しました</h2>
          <p className="status-text-small">変更後のカードは設定タブの「ライセンス」に表示されます</p>
          <button type="button" className="btn-primary" onClick={onBack}>
            設定へ戻る
          </button>
        </div>
      </section>
    );
  }

  if (step.kind === 'already-active') {
    return (
      <section className="checkout-screen">
        <div className="checkout-panel checkout-complete">
          <h2>既にライセンスがあります</h2>
          <p className="status-text-small">このアカウントのライセンスは有効です。お支払いは不要です。</p>
          <button type="button" className="btn-primary" onClick={onBack}>
            設定へ戻る
          </button>
        </div>
      </section>
    );
  }

  const badge = brandLabel(brand);

  return (
    <section className="checkout-screen">
      <button type="button" className="back-link" onClick={onBack}>
        ← 戻る
      </button>

      <form className="checkout-panel" onSubmit={(e) => void handleSubmit(e)}>
        <div className="checkout-summary">
          {intent === 'change-card' ? (
            <h2>お支払い方法の変更</h2>
          ) : (
            <>
              <h2>IT-Index プレミアム</h2>
              <p className="checkout-price">
                ¥300 <span className="checkout-price-period">/ 月</span>
              </p>
            </>
          )}
          <p className="status-text-small">モック決済です。実際の課金は発生しません</p>
          <p className="checkout-warning-note">実際のクレジットカード番号は登録しないでください</p>
        </div>

        <div>
          <label htmlFor="checkout-card-number">カード番号</label>
          <div className="checkout-card-field">
            <input
              id="checkout-card-number"
              type="text"
              inputMode="numeric"
              autoComplete="cc-number"
              placeholder="XXXX XXXX XXXX XXXX"
              value={cardNumber}
              onChange={(e) => setCardNumber(formatCardNumber(normalizeCardNumber(e.target.value)))}
              onBlur={() => setTouched((t) => ({ ...t, card: true }))}
            />
            {badge !== null && <span className="payment-brand-pill checkout-brand-badge">{badge}</span>}
          </div>
          {touched.card && !cardValid && <p className="checkout-field-error">カード番号が正しくありません</p>}
        </div>

        <div className="checkout-row">
          <div>
            <label htmlFor="checkout-expiry">有効期限(月/年)</label>
            <input
              id="checkout-expiry"
              type="text"
              inputMode="numeric"
              autoComplete="cc-exp"
              placeholder="XX/XX"
              value={expiry}
              onChange={(e) => setExpiry(formatExpiry(e.target.value))}
              onBlur={() => setTouched((t) => ({ ...t, expiry: true }))}
            />
            {touched.expiry && !expiryValid && (
              <p className="checkout-field-error">有効期限が正しくありません</p>
            )}
          </div>
          <div>
            <label htmlFor="checkout-cvc">セキュリティコード</label>
            <input
              id="checkout-cvc"
              type="text"
              inputMode="numeric"
              autoComplete="cc-csc"
              placeholder={brand === 'amex' ? 'XXXX' : 'XXX'}
              value={cvc}
              onChange={(e) => setCvc(e.target.value.replace(/\D/g, '').slice(0, 4))}
              onBlur={() => setTouched((t) => ({ ...t, cvc: true }))}
            />
            {touched.cvc && !cvcValid && (
              <p className="checkout-field-error">セキュリティコードが正しくありません</p>
            )}
          </div>
        </div>

        <div>
          <label htmlFor="checkout-holder-name">カード名義</label>
          <input
            id="checkout-holder-name"
            type="text"
            autoComplete="cc-name"
            placeholder="TARO YAMADA"
            value={holderName}
            onChange={(e) => setHolderName(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, name: true }))}
          />
          {touched.name && !nameValid && <p className="checkout-field-error">カード名義を入力してください</p>}
        </div>

        {submitError && <p className="sync-error">{submitError}</p>}

        <button type="submit" className="btn-primary checkout-pay-btn" disabled={!allValid}>
          {intent === 'change-card' ? 'このカードに変更する' : '¥300 を支払う'}
        </button>
        {/* 送信するものを正確に書く。カード番号とCVCは本当に送らないが、表示用の下4桁などは
            アカウントに紐づけて保存する(端末を変えても請求先が分かるようにするため) */}
        <p className="status-text-small checkout-secure-note">
          🔒 カード番号とセキュリティコードは送信されません。ブランド・下4桁・有効期限・名義のみ、
          お支払い方法の表示用にアカウントへ保存します
        </p>
      </form>
    </section>
  );
}

/** 完了画面のチェックマーク。currentColorでテーマに追従する */
function CompleteIcon() {
  return (
    <svg
      className="checkout-complete-icon"
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      aria-hidden="true"
    >
      <circle cx="24" cy="24" r="21" />
      <path d="M14 24.5 21 31.5 34 17.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
