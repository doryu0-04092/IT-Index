/**
 * チェックアウト画面(要件定義書§4.2「決済はモック」)。設定タブの商品カードから遷移する
 * 全画面のクレジットカード決済フォーム(本人指定: Stripe Checkout風・全画面形式)。
 *
 * カード情報(番号・有効期限・CVC・名義)の検証はlib/cardValidation.tsの純関数で
 * フロント側で完結し、**サーバーへは一切送らない**(本人指定)。「支払い」の実体は
 * processPayment propに委譲する——本番はApp.tsxが既存のpurchaseLicense(token)を渡し、
 * devプレビュー(dev/CheckoutPreview.tsx)とテストはモックを渡す。この分離により、
 * 画面側は決済APIの契約(コード発行・409 license_already_active)だけを知っていればよい。
 */
import { useState } from 'react';
import { ApiRequestError } from '../sync/apiClient';
import {
  detectBrand,
  formatCardNumber,
  formatExpiry,
  normalizeCardNumber,
  validateCardNumber,
  validateCvc,
  validateExpiry,
  type CardBrand,
} from '../lib/cardValidation';

export interface CheckoutScreenProps {
  /** 「戻る」「設定へ戻る」で呼ぶ。戻り先は常に設定タブ(入口が設定タブのみのためreturnToは持たない) */
  onBack: () => void;
  /** 決済処理の実体。本番はApp.tsxがpurchaseLicense(token)を渡し、プレビュー/テストはモックを渡す */
  processPayment: () => Promise<{ code: string; activatedAt: number }>;
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
  | { kind: 'already-active' };

/** ブランドバッジの表示名。unknownはバッジ自体を出さない */
const BRAND_LABELS: Record<Exclude<CardBrand, 'unknown'>, string> = {
  visa: 'VISA',
  mastercard: 'Mastercard',
  amex: 'AMEX',
  jcb: 'JCB',
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function CheckoutScreen({
  onBack,
  processPayment,
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!allValid || step.kind !== 'form') return;
    setSubmitError(null);
    setStep({ kind: 'processing' });
    try {
      const [result] = await Promise.all([processPayment(), delay(processingMinDelayMs)]);
      setStep({ kind: 'complete', code: result.code });
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'license_already_active') {
        setStep({ kind: 'already-active' });
        return;
      }
      setStep({ kind: 'form' });
      setSubmitError(err instanceof ApiRequestError ? err.message : 'サーバーに接続できませんでした');
    }
  }

  if (step.kind === 'processing') {
    return (
      <section className="checkout-screen">
        <div className="checkout-panel checkout-processing" role="status">
          <span className="checkout-spinner" aria-hidden="true" />
          <p>決済を処理しています…</p>
          <p className="status-text-small">モック決済です。実際の課金は発生しません</p>
        </div>
      </section>
    );
  }

  if (step.kind === 'complete') {
    return (
      <section className="checkout-screen">
        <div className="checkout-panel checkout-complete">
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
          <h2>お支払いが完了しました</h2>
          <p>
            ライセンスコード:{' '}
            <code className="license-code" data-testid="license-code">
              {step.code}
            </code>
          </p>
          <p className="status-text-small">モック決済のため、実際の課金は発生していません</p>
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

  return (
    <section className="checkout-screen">
      <button type="button" className="back-link" onClick={onBack}>
        ← 戻る
      </button>

      <form className="checkout-panel" onSubmit={(e) => void handleSubmit(e)}>
        <div className="checkout-summary">
          <h2>IT-Index プレミアム</h2>
          <p className="checkout-price">
            ¥300 <span className="checkout-price-period">/ 月</span>
          </p>
          <p className="status-text-small">モック決済です。実際の課金は発生しません</p>
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
            {brand !== 'unknown' && <span className="checkout-brand-badge">{BRAND_LABELS[brand]}</span>}
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
          ¥300 を支払う
        </button>
        <p className="status-text-small checkout-secure-note">
          🔒 カード情報は端末内でのみ検証され、送信されません
        </p>
      </form>
    </section>
  );
}
