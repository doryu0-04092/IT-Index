/**
 * モック決済のお支払い方法・ライセンスコードの端末内保存(要件定義書§4.2「決済はモック」)。
 * カード情報はサーバーへ一切送らない(本人指定)ため、設定タブに表示する「お支払い方法」
 * (ブランド・下4桁・有効期限・名義)とチェックアウトで発行されたライセンスコードは、
 * この端末のlocalStorageにだけ持つ。
 *
 * キーは'it-index-v2'接頭辞で統一(lib/factoryReset.tsが接頭辞一致で一括削除するため、
 * オールクリア時に自動で消える)。
 *
 * 注意: last4以外の番号・CVCは保存しない。モックであっても完全なカード番号を
 * 端末に残さない(実サービスの慣行に合わせる)。
 */
import type { CardBrand } from './cardValidation';

const PAYMENT_METHOD_KEY = 'it-index-v2:mock-payment-method';
const LICENSE_CODE_KEY = 'it-index-v2:license-code';

export interface StoredPaymentMethod {
  brand: CardBrand;
  /** カード番号の下4桁のみ(完全な番号は保存しない) */
  last4: string;
  /** "MM/YY" */
  expiry: string;
  holderName: string;
}

const VALID_BRANDS: CardBrand[] = ['visa', 'mastercard', 'amex', 'jcb', 'unknown'];

/** 保存済みのお支払い方法。無い・壊れている場合はnull */
export function getStoredPaymentMethod(): StoredPaymentMethod | null {
  try {
    const raw = localStorage.getItem(PAYMENT_METHOD_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const v = parsed as Record<string, unknown>;
    if (
      typeof v.brand !== 'string' ||
      !VALID_BRANDS.includes(v.brand as CardBrand) ||
      typeof v.last4 !== 'string' ||
      typeof v.expiry !== 'string' ||
      typeof v.holderName !== 'string'
    ) {
      return null;
    }
    return { brand: v.brand as CardBrand, last4: v.last4, expiry: v.expiry, holderName: v.holderName };
  } catch {
    return null;
  }
}

export function setStoredPaymentMethod(method: StoredPaymentMethod): void {
  localStorage.setItem(PAYMENT_METHOD_KEY, JSON.stringify(method));
}

/** チェックアウトで発行されたライセンスコード。無い場合はnull(コード入力で有効化した等) */
export function getStoredLicenseCode(): string | null {
  return localStorage.getItem(LICENSE_CODE_KEY);
}

export function setStoredLicenseCode(code: string): void {
  localStorage.setItem(LICENSE_CODE_KEY, code);
}
