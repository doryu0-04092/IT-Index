/**
 * 旧形式(端末内localStorage)のお支払い方法の後始末。
 *
 * お支払い方法は元々この端末のlocalStorageにだけ保存していたが、ライセンスの有効/無効は
 * アカウント単位(サーバー)で持つため、購入した端末以外では「ライセンス有効なのにカード未登録」
 * という矛盾表示になっていた。現在はサーバーが唯一の正(lib/paymentStore.tsは削除済み)。
 *
 * このモジュールは**旧バージョンで購入した端末に残っている値を一度だけサーバーへ移した上で
 * 消す**ためだけに存在する。移送が済めばキーは残らないので、以降は何もしない。
 * 将来、旧バージョンからの更新経路が無くなった時点でファイルごと削除してよい。
 */
import type { PaymentMethod } from '../sync/apiClient';
import type { CardBrand } from './cardValidation';

const LEGACY_PAYMENT_METHOD_KEY = 'it-index-v2:mock-payment-method';
const LEGACY_LICENSE_CODE_KEY = 'it-index-v2:license-code';

const VALID_BRANDS: CardBrand[] = ['visa', 'mastercard', 'amex', 'jcb', 'unknown'];

/**
 * 旧キーに残っているお支払い方法。無い・壊れている場合はnull。
 * サーバーの検証(paymentMethod.ts)を通らない値を送っても400になるだけなので、
 * ここでは形が揃っているかだけを見る。
 */
export function readLegacyPaymentMethod(): PaymentMethod | null {
  try {
    const raw = localStorage.getItem(LEGACY_PAYMENT_METHOD_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const v = parsed as Record<string, unknown>;
    if (
      typeof v.brand !== 'string' ||
      !VALID_BRANDS.includes(v.brand as CardBrand) ||
      typeof v.last4 !== 'string' ||
      !/^[0-9]{4}$/.test(v.last4) ||
      typeof v.expiry !== 'string' ||
      !/^(0[1-9]|1[0-2])\/[0-9]{2}$/.test(v.expiry) ||
      typeof v.holderName !== 'string' ||
      v.holderName.trim() === ''
    ) {
      return null;
    }
    return {
      brand: v.brand as CardBrand,
      last4: v.last4,
      expiry: v.expiry,
      holderName: v.holderName.trim(),
    };
  } catch {
    return null;
  }
}

/** 移送が済んだ(または値が壊れていて移送できない)旧キーを消す */
export function clearLegacyPaymentKeys(): void {
  localStorage.removeItem(LEGACY_PAYMENT_METHOD_KEY);
  localStorage.removeItem(LEGACY_LICENSE_CODE_KEY);
}

/** 旧キーが1つでも残っているか(移送処理を走らせるかの判定) */
export function hasLegacyPaymentKeys(): boolean {
  return (
    localStorage.getItem(LEGACY_PAYMENT_METHOD_KEY) !== null ||
    localStorage.getItem(LEGACY_LICENSE_CODE_KEY) !== null
  );
}
