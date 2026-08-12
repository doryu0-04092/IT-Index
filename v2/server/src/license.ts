// ライセンス基盤(requirements.md §4「提供形態」/ architecture.md §3・§4・§5)。
//
// 公式ホストでは「端末間同期」と「運営者キーでのAI利用」を、有効なライセンスを持つ
// アカウントに限る。BYOK(利用者が自分のキーを持ち込む経路)と接続テストは費用が本人負担の
// ためライセンス不要。セルフホストには運用主体=利用者自身でライセンス概念が無いため、
// LICENSE_ENABLED='0' で確認そのものを止められる(deploy.md「運用メモ」)。
//
// ゲートの判定・実行はindex.tsのルートハンドラ側に置く(architecture.md §5の方針)。
// ai.tsのresolveCallProviderには一切触らない: あちらは「利用者キーが有るか無いか」だけを
// 判定する関数で、既存の不変条件(利用者キーの有無=上限スキップの唯一条件)を読みやすく
// 保つため、公式ホスト限定の追加条件(ライセンス)を混ぜない。
//
// コード値はレスポンス・ログ・エラーメッセージに出さない(唯一の例外は購入時に
// 発行したコードを本人へ返す応答で、これは仕様。requirements.md §4.2)。
import type { Env } from './types';
import { timingSafeEqualString } from './crypto';
// UNIQUE制約違反の判定はdb.tsの実装を再利用する(同じ判定を二重に持たない)。
import { isUniqueConstraintError } from './db';

/** architecture.md §3のsource列。'purchase'=決済モック経由 / 'operator'=運営者の手動発行 */
export type LicenseSource = 'purchase' | 'operator';

export type LicenseRow = {
  code: string;
  account_id: string | null;
  source: string;
  issued_at: number;
  activated_at: number | null;
};

// コード形式 ITX-XXXX-XXXX-XXXX。英数大文字から紛らわしい文字(I/O/0/1)を除いた32文字を使う。
// 12文字×5ビット=60ビットのエントロピー(乱数はcrypto.getRandomValues由来)。
// 32は256の約数なので、乱数バイトを & 0x1f で写しても出現確率に偏り(modulo bias)が出ない。
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_GROUPS = 3;
const CODE_GROUP_LENGTH = 4;
const CODE_BYTES = CODE_GROUPS * CODE_GROUP_LENGTH;

// 発行コードの生成でPRIMARY KEY衝突が起きた場合の再試行回数(60ビットなので実際にはまず起きない。
// db.tsのinsertSyncBlobと同じ「衝突だけを検出して1回だけ引き直す」方針)。
const MAX_ISSUE_ATTEMPTS = 2;

// 有効化・購入の試行回数の日次上限。認証済みアカウントからの総当たり(運営者コード狙い)と
// 発行の乱発を抑えるための値で、ai_usageの予約キー方式で数える。
export const LICENSE_DAILY_ATTEMPT_LIMIT = 10;

// 入力コードの上限長・文字種。運営者コード(LICENSE_CODES)は運営者が決める任意の文字列なので
// 形式は狭めすぎず、制御文字・空白・改行だけを弾く(印字可能ASCII。ai.tsのAPIキー検証と同じ方針)。
const MAX_CODE_CHARS = 100;
const CODE_PATTERN = /^[\x21-\x7e]+$/;

/**
 * ai_usageテーブルの予約キー(db.tsのaiTestUsageAccountIdと同じ方式)。
 * 実在のアカウントID(UUID)や'__global__'と衝突しない'license:'前置の行で
 * ライセンス操作の試行回数を数える。テーブルは増やさない。
 */
export function licenseUsageAccountId(accountId: string): string {
  return `license:${accountId}`;
}

/** 未設定・'1'ならゲート有効。'0'だけがキルスイッチ(セルフホスト用) */
export function isLicenseEnabled(env: Env): boolean {
  return env.LICENSE_ENABLED !== '0';
}

/** LICENSE_CODES(カンマ区切り。Workers Secret想定)を運営者コードの集合として読む */
function operatorCodes(env: Env): string[] {
  return (env.LICENSE_CODES ?? '')
    .split(',')
    .map((code) => code.trim())
    .filter((code) => code.length > 0);
}

/**
 * 入力が運営者コードのいずれかに一致するかを定数時間比較で判定する。
 * 一致した後も残りの候補を比較し続ける: 何件目で一致したか(=どのコードか)を
 * 実行時間から推測させないため、早期returnしない。
 */
export async function matchesOperatorCode(env: Env, code: string): Promise<boolean> {
  let matched = false;
  for (const candidate of operatorCodes(env)) {
    if (await timingSafeEqualString(candidate, code)) matched = true;
  }
  return matched;
}

export type CodeValidation = { ok: true; code: string } | { ok: false; error: string };

/** 入力コードの形式検証。エラー文には入力値を一切載せない(部分一致のヒントを与えない) */
export function validateCodeInput(input: unknown): CodeValidation {
  if (typeof input !== 'string') {
    return { ok: false, error: 'codeは文字列で指定してください' };
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'ライセンスコードを入力してください' };
  }
  if (trimmed.length > MAX_CODE_CHARS) {
    return { ok: false, error: `codeは${MAX_CODE_CHARS}文字以下にしてください` };
  }
  if (!CODE_PATTERN.test(trimmed)) {
    return { ok: false, error: 'codeに使用できない文字が含まれています' };
  }
  return { ok: true, code: trimmed };
}

export function generateLicenseCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_BYTES));
  const chars = Array.from(bytes, (byte) => CODE_ALPHABET[byte & 0x1f]);
  const groups: string[] = [];
  for (let group = 0; group < CODE_GROUPS; group++) {
    const start = group * CODE_GROUP_LENGTH;
    groups.push(chars.slice(start, start + CODE_GROUP_LENGTH).join(''));
  }
  return `ITX-${groups.join('-')}`;
}

/** 有効化済みの行が1件でもあればライセンス保有。索引はidx_licenses_account_id(0003) */
export async function hasActiveLicense(db: D1Database, accountId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS ok FROM licenses WHERE account_id = ?1 AND activated_at IS NOT NULL LIMIT 1')
    .bind(accountId)
    .first<{ ok: number }>();
  return row !== null;
}

export async function findLicenseByCode(db: D1Database, code: string): Promise<LicenseRow | null> {
  return db
    .prepare('SELECT code, account_id, source, issued_at, activated_at FROM licenses WHERE code = ?1')
    .bind(code)
    .first<LicenseRow>();
}

/**
 * 決済モックの「発行+即時有効化」(requirements.md §4.2)。
 * 発行と有効化を分離したスキーマのまま、購入経路では同一トランザクション相当の
 * 1つのINSERTで両方を埋める(実課金に置き換わっても、発行だけを先に行う経路を後から足せる)。
 */
export async function issuePurchasedLicense(
  db: D1Database,
  accountId: string,
  now: number
): Promise<{ code: string; activatedAt: number }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ISSUE_ATTEMPTS; attempt++) {
    const code = generateLicenseCode();
    try {
      await db
        .prepare(
          `INSERT INTO licenses (code, account_id, source, issued_at, activated_at)
           VALUES (?1, ?2, 'purchase', ?3, ?3)`
        )
        .bind(code, accountId, now)
        .run();
      return { code, activatedAt: now };
    } catch (err) {
      lastError = err;
      if (!isUniqueConstraintError(err)) throw err;
    }
  }
  throw lastError;
}

/**
 * 未有効化の既存コードを有効化する。WHERE activated_at IS NULL を条件に含めることで、
 * 同じコードを2アカウントが同時に送っても後発は0行更新(=false)になり、1コード1アカウントが
 * SQL側で保証される(アプリ側のチェックと更新の間の競合に依存しない)。
 */
export async function activateExistingLicense(
  db: D1Database,
  code: string,
  accountId: string,
  now: number
): Promise<boolean> {
  const row = await db
    .prepare(
      `UPDATE licenses SET account_id = ?2, activated_at = ?3
       WHERE code = ?1 AND activated_at IS NULL
       RETURNING code`
    )
    .bind(code, accountId, now)
    .first<{ code: string }>();
  return row !== null;
}

/**
 * 運営者コード(LICENSE_CODES)の初回使用。行を作って同時に有効化する。
 * 2回目以降の同一コードは行が既に存在するため、この関数ではなく
 * activateExistingLicense/findLicenseByCode の経路(=使用済み判定)に落ちる。
 * 同時実行はPRIMARY KEY衝突で後発がfalseになる。
 */
export async function insertOperatorLicense(
  db: D1Database,
  code: string,
  accountId: string,
  now: number
): Promise<boolean> {
  try {
    await db
      .prepare(
        `INSERT INTO licenses (code, account_id, source, issued_at, activated_at)
         VALUES (?1, ?2, 'operator', ?3, ?3)`
      )
      .bind(code, accountId, now)
      .run();
    return true;
  } catch (err) {
    if (isUniqueConstraintError(err)) return false;
    throw err;
  }
}
