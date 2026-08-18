// お支払い方法の表示情報(requirements.md §4.2 / migrations/0004)。
//
// 保持するのは画面に出す4項目(ブランド・下4桁・有効期限・名義)だけ。
// **完全なカード番号とCVCは受け取らないし、保存もしない**——モックであっても実カード情報を
// 残さない方針は、サーバーへ移した後も変えていない。検証もその前提で「表示できる形か」しか見ない
// (実在するカードかどうかは判定しない。クライアント側のlib/cardValidation.tsと同じ緩さ)。
//
// 入力検証はlicense.tsのvalidateCodeInputと同じ方針: 型・長さ・文字種だけを見て、
// エラー文には入力値を載せない。

/** クライアントのlib/cardValidation.tsのCardBrandと同じ集合(ここが受け入れの正) */
const VALID_BRANDS = ['visa', 'mastercard', 'amex', 'jcb', 'unknown'] as const;
export type CardBrand = (typeof VALID_BRANDS)[number];

export type PaymentMethod = {
  brand: CardBrand;
  last4: string;
  expiry: string;
  holderName: string;
};

type PaymentMethodRow = {
  brand: string;
  last4: string;
  expiry: string;
  holder_name: string;
};

// 名義は印字可能ASCII(license.tsのコード検証と同じ方針)。長さは実在カードの上限より
// 余裕を持たせつつ、無制限の文字列を受けないための上限。
const MAX_HOLDER_NAME_CHARS = 100;
const LAST4_PATTERN = /^[0-9]{4}$/;
const EXPIRY_PATTERN = /^(0[1-9]|1[0-2])\/[0-9]{2}$/;
const HOLDER_NAME_PATTERN = /^[\x20-\x7e]+$/;

export type PaymentMethodValidation =
  | { ok: true; method: PaymentMethod }
  | { ok: false; error: string };

export function validatePaymentMethodInput(input: unknown): PaymentMethodValidation {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'お支払い方法の形式が正しくありません' };
  }
  const v = input as Record<string, unknown>;

  if (typeof v.brand !== 'string' || !VALID_BRANDS.includes(v.brand as CardBrand)) {
    return { ok: false, error: 'brandの値が正しくありません' };
  }
  if (typeof v.last4 !== 'string' || !LAST4_PATTERN.test(v.last4)) {
    return { ok: false, error: 'last4は数字4桁で指定してください' };
  }
  if (typeof v.expiry !== 'string' || !EXPIRY_PATTERN.test(v.expiry)) {
    return { ok: false, error: 'expiryはMM/YY形式で指定してください' };
  }
  const holderName = typeof v.holderName === 'string' ? v.holderName.trim() : '';
  if (holderName === '') {
    return { ok: false, error: 'カード名義を入力してください' };
  }
  if (holderName.length > MAX_HOLDER_NAME_CHARS) {
    return { ok: false, error: `カード名義は${MAX_HOLDER_NAME_CHARS}文字以下にしてください` };
  }
  if (!HOLDER_NAME_PATTERN.test(holderName)) {
    return { ok: false, error: 'カード名義に使用できない文字が含まれています' };
  }

  return {
    ok: true,
    method: { brand: v.brand as CardBrand, last4: v.last4, expiry: v.expiry, holderName },
  };
}

export async function getPaymentMethod(
  db: D1Database,
  accountId: string
): Promise<PaymentMethod | null> {
  const row = await db
    .prepare('SELECT brand, last4, expiry, holder_name FROM payment_methods WHERE account_id = ?1')
    .bind(accountId)
    .first<PaymentMethodRow>();
  if (row === null) return null;
  return {
    // 列は自由文字列だが、書き込み経路がvalidatePaymentMethodInputだけなので既知の値しか入らない
    brand: row.brand as CardBrand,
    last4: row.last4,
    expiry: row.expiry,
    holderName: row.holder_name,
  };
}

/** 1アカウント1枚。カード変更はこのUPSERTで既存行を上書きする */
export async function upsertPaymentMethod(
  db: D1Database,
  accountId: string,
  method: PaymentMethod,
  now: number
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO payment_methods (account_id, brand, last4, expiry, holder_name, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(account_id) DO UPDATE SET
         brand = excluded.brand,
         last4 = excluded.last4,
         expiry = excluded.expiry,
         holder_name = excluded.holder_name,
         updated_at = excluded.updated_at`
    )
    .bind(accountId, method.brand, method.last4, method.expiry, method.holderName, now)
    .run();
}

/** 解約時に呼ぶ。解約後は「引き落とされるカード」が存在しないため行ごと消す */
export async function deletePaymentMethod(db: D1Database, accountId: string): Promise<void> {
  await db.prepare('DELETE FROM payment_methods WHERE account_id = ?1').bind(accountId).run();
}
