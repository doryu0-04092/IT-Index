import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { BASE, authHeaders, grantLicense, signupAccount } from './helpers';

// お支払い方法の表示情報(src/paymentMethod.ts / migrations/0004)。
//
// 元は端末のlocalStorageにだけ持っていたため、購入した端末以外では「ライセンス有効なのに
// カード未登録」という矛盾表示になっていた。ここでの検証の要点は
// (a) アカウント単位で保存され、別セッションからも同じ値が読めること
// (b) アカウントをまたいで漏れないこと
// (c) 完全なカード番号・CVCを受け取る経路が無いこと。

const VISA = { brand: 'visa', last4: '4242', expiry: '12/29', holderName: 'TARO YAMADA' };

async function putPaymentMethod(token: string, body: unknown) {
  return exports.default.fetch(`${BASE}/api/payment-method`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
}

async function getMe(token: string) {
  return exports.default.fetch(`${BASE}/api/auth/me`, { headers: authHeaders(token) });
}

describe('PUT /api/payment-method', () => {
  it('ライセンスを持つアカウントはお支払い方法を保存でき、/api/auth/meから読める', async () => {
    const account = await signupAccount('pm-save');

    const res = await putPaymentMethod(account.token, VISA);
    expect(res.status).toBe(200);

    // 別リクエスト(=別端末からの取得に相当)でも同じ値が返る
    const me = await getMe(account.token);
    const body = await me.json<{ paymentMethod: unknown; licensed: boolean }>();
    expect(body.licensed).toBe(true);
    expect(body.paymentMethod).toEqual(VISA);
  });

  it('ライセンスが無いアカウントは403(実課金と無関係なカードを登録させない)', async () => {
    const account = await signupAccount('pm-nolicense', { license: false });

    const res = await putPaymentMethod(account.token, VISA);
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('license_required');

    const me = await getMe(account.token);
    expect((await me.json<{ paymentMethod: unknown }>()).paymentMethod).toBeNull();
  });

  it('カード変更は既存の1件を上書きする(アカウントごとに1枚)', async () => {
    const account = await signupAccount('pm-update');

    await putPaymentMethod(account.token, VISA);
    await putPaymentMethod(account.token, {
      brand: 'jcb',
      last4: '9999',
      expiry: '01/30',
      holderName: 'HANAKO SUZUKI',
    });

    const me = await getMe(account.token);
    const body = await me.json<{ paymentMethod: { brand: string; last4: string } }>();
    expect(body.paymentMethod.brand).toBe('jcb');
    expect(body.paymentMethod.last4).toBe('9999');

    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM payment_methods WHERE account_id = ?1')
      .bind(account.accountId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it('他人のお支払い方法は見えない', async () => {
    const owner = await signupAccount('pm-owner');
    const other = await signupAccount('pm-other');

    await putPaymentMethod(owner.token, VISA);

    const me = await getMe(other.token);
    expect((await me.json<{ paymentMethod: unknown }>()).paymentMethod).toBeNull();
  });

  it.each([
    ['brandが未知の値', { ...VISA, brand: 'diners' }],
    ['last4が4桁でない', { ...VISA, last4: '424' }],
    ['last4が数字でない', { ...VISA, last4: '42a2' }],
    ['expiryがMM/YY形式でない', { ...VISA, expiry: '2029-12' }],
    ['expiryの月が範囲外', { ...VISA, expiry: '13/29' }],
    ['名義が空', { ...VISA, holderName: '   ' }],
    ['オブジェクトでない', 'visa'],
  ])('不正な入力は400: %s', async (_label, body) => {
    const account = await signupAccount('pm-invalid');

    const res = await putPaymentMethod(account.token, body);
    expect(res.status).toBe(400);
  });

  it('完全なカード番号やCVCを送っても保存されない(列が無いので取り込まれない)', async () => {
    const account = await signupAccount('pm-extra');

    await putPaymentMethod(account.token, { ...VISA, cardNumber: '4242424242424242', cvc: '123' });

    const row = await env.DB.prepare('SELECT * FROM payment_methods WHERE account_id = ?1')
      .bind(account.accountId)
      .first<Record<string, unknown>>();
    expect(JSON.stringify(row)).not.toContain('4242424242424242');
    expect(JSON.stringify(row)).not.toContain('123');
  });

  it('認証が無ければ401', async () => {
    const res = await exports.default.fetch(`${BASE}/api/payment-method`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(VISA),
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/auth/me のライセンス情報', () => {
  it('購入経路のコード・source・課金開始日を本人に返す', async () => {
    const account = await signupAccount('me-purchase', { license: false });
    const code = await grantLicense(account.accountId, 'purchase');

    const me = await getMe(account.token);
    const body = await me.json<{
      licensed: boolean;
      licenseCode: string;
      licenseSource: string;
      activatedAt: number;
    }>();
    expect(body.licensed).toBe(true);
    expect(body.licenseCode).toBe(code);
    expect(body.licenseSource).toBe('purchase');
    expect(typeof body.activatedAt).toBe('number');
  });

  it('運営者コードはsource=operatorとして返す(クライアントが課金の有無を判別できる)', async () => {
    const account = await signupAccount('me-operator');

    const me = await getMe(account.token);
    expect((await me.json<{ licenseSource: string }>()).licenseSource).toBe('operator');
  });

  it('未ライセンスならライセンス関連は全てnull', async () => {
    const account = await signupAccount('me-none', { license: false });

    const me = await getMe(account.token);
    const body = await me.json<{
      licensed: boolean;
      licenseCode: null;
      licenseSource: null;
      activatedAt: null;
      paymentMethod: null;
    }>();
    expect(body.licensed).toBe(false);
    expect(body.licenseCode).toBeNull();
    expect(body.licenseSource).toBeNull();
    expect(body.activatedAt).toBeNull();
    expect(body.paymentMethod).toBeNull();
  });
});
