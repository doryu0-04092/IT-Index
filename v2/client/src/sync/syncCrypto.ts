/**
 * 同期ペイロードの端末側暗号化(#182)。
 *
 * `docs/v2/architecture.md` §6「同期ブロブの暗号化(端末側で暗号化してから預ける方式)/
 * 少なくとも平文の学習履歴を無期限保存しない」の実装。**サーバーは鍵を持たない。**
 * 端末が持つランダムな256bitのデータ鍵(DK)でAES-GCM暗号化してから預けるため、
 * `sync_blobs.payload` には暗号文しか入らない。
 *
 * WebCryptoだけで組む(新規依存を足さない)。Chrome/Edge・Android WebView のどちらでも
 * `crypto.subtle` が使えることが前提。
 *
 * **`shared/` ではなく client に置く。** sharedは端末とサーバーの両方がコンパイルする
 * 環境非依存のパッケージ(`lib: ["ESNext"]`)で、WebCryptoの型が無い。そして
 * **サーバーは暗号処理を一切しない**——`sync_blobs.payload` も包まれた鍵も、中身を解釈せず
 * 文字列として保管するだけなので、共有する必要が無い。
 *
 * DKを別の端末へ渡す経路は2つあり、どちらもこのファイルの関数で組み立てる:
 * - QR: DKをそのままbase64urlで載せる(サーバーを通らない)
 * - 8桁コード: DKをコード由来の鍵で包み、サーバーへ5分だけ置く(`wrapDataKey`/`unwrapDataKey`)
 */

const AES_ALGO = 'AES-GCM';
const IV_BYTES = 12;
const KEY_BYTES = 32;

/**
 * コードから鍵を導出する際の反復回数。8桁(10^8通り)しかないコードを包む鍵にするため、
 * 総当たり1回あたりのコストを上げる目的で大きめに取る。
 * 端末側の1回の導出は体感できる遅さにはならない(受け渡し時に1回だけ実行する)。
 */
const CODE_KDF_ITERATIONS = 600_000;

/** エンベロープの版。形式を変える時はここを上げ、古い版の読み取り可否を明示的に決める */
const ENVELOPE_VERSION = 1;

export interface SyncEnvelope {
  encSchemaVersion: number;
  alg: 'A256GCM';
  /** base64 */
  iv: string;
  /** base64 */
  ct: string;
}

/* ------------------------------------------------------------------ */
/* base64 / base64url                                                  */
/* ------------------------------------------------------------------ */

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  return fromBase64(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
}

/** WebCryptoのBufferSource用。Uint8Arrayのviewをそのまま渡さず、実体のArrayBufferを切り出す */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/* ------------------------------------------------------------------ */
/* データ鍵(DK)                                                        */
/* ------------------------------------------------------------------ */

/** 新しいデータ鍵を作る。base64urlの文字列で持ち回る(localStorage・QRに載る形) */
export function generateDataKey(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}

/**
 * base64urlのデータ鍵をAES-GCMのCryptoKeyへ読み込む。
 * 形式不正・鍵長違いは `null`(例外を投げない)——受け取ったQR・保存値が壊れていても
 * 呼び出し側が「使えない鍵」として素直に扱えるようにする。
 */
export async function importDataKey(dataKey: string): Promise<CryptoKey | null> {
  let raw: Uint8Array;
  try {
    raw = fromBase64Url(dataKey);
  } catch {
    return null;
  }
  if (raw.length !== KEY_BYTES) return null;

  try {
    return await crypto.subtle.importKey('raw', toArrayBuffer(raw), AES_ALGO, false, [
      'encrypt',
      'decrypt',
    ]);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* ペイロードの暗号化・復号                                             */
/* ------------------------------------------------------------------ */

/**
 * 同期ペイロード(JSON文字列)を暗号化し、エンベロープのJSON文字列にして返す。
 * 既存の `sync_blobs.payload`(TEXT)へそのまま載るため、**サーバー側のスキーマは変えない**。
 */
export async function encryptSyncPayload(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: AES_ALGO, iv },
    key,
    new TextEncoder().encode(plaintext),
  );

  const envelope: SyncEnvelope = {
    encSchemaVersion: ENVELOPE_VERSION,
    alg: 'A256GCM',
    iv: toBase64(iv),
    ct: toBase64(new Uint8Array(ciphertext)),
  };
  return JSON.stringify(envelope);
}

/**
 * エンベロープかどうかの判別。**平文の同期ファイル(SyncFile)を誤ってエンベロープと
 * 見なさないこと**が要件——移行期間中は両方がサーバーに並ぶため、判別を誤ると
 * 読めるはずのデータを読み飛ばす。`encSchemaVersion` と `alg` の両方を見る。
 */
export function isSyncEnvelope(raw: unknown): raw is SyncEnvelope {
  if (typeof raw !== 'object' || raw === null) return false;
  const v = raw as Record<string, unknown>;
  return (
    typeof v.encSchemaVersion === 'number' &&
    v.alg === 'A256GCM' &&
    typeof v.iv === 'string' &&
    typeof v.ct === 'string'
  );
}

/**
 * エンベロープを復号して元のJSON文字列を返す。
 * 鍵違い・改竄・形式不正はすべて `null`(例外を投げない)——呼び出し側は
 * 「この端末の鍵では読めなかった」として件数に数え、他のblobの取り込みを続ける。
 */
export async function decryptSyncPayload(key: CryptoKey, envelope: SyncEnvelope): Promise<string | null> {
  if (envelope.encSchemaVersion !== ENVELOPE_VERSION) return null;

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: AES_ALGO, iv: toArrayBuffer(fromBase64(envelope.iv)) },
      key,
      toArrayBuffer(fromBase64(envelope.ct)),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* QRでの受け渡し                                                       */
/* ------------------------------------------------------------------ */

/** QRに載せる形。鍵だけなので1枚に十分収まる */
export interface KeyQrPayload {
  v: 1;
  dk: string;
}

export function buildKeyQrPayload(dataKey: string): string {
  const payload: KeyQrPayload = { v: 1, dk: dataKey };
  return JSON.stringify(payload);
}

/**
 * 読み取ったQRの中身からデータ鍵を取り出す。**鍵として使える形かをここで確かめる**
 * (長さ32バイトのbase64urlであること)。別のQRを読んでしまった場合に、
 * 使えない値をそのまま保存して以後ずっと復号に失敗する状態を作らないため。
 */
export async function parseKeyQrPayload(text: string): Promise<string | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;

  const v = raw as Record<string, unknown>;
  if (v.v !== 1 || typeof v.dk !== 'string') return null;

  // 鍵として読み込めるかまで確かめる(形式だけ合っている壊れた値を弾く)
  return (await importDataKey(v.dk)) !== null ? v.dk : null;
}

/* ------------------------------------------------------------------ */
/* 8桁コードでの受け渡し                                                */
/* ------------------------------------------------------------------ */

/** 受け渡しコードの桁数。増やしたい場合はここだけを変える(強度は桁数に比例して上がる) */
export const TRANSFER_CODE_DIGITS = 8;

/**
 * 受け渡しコードを作る。**`Math.random()` ではなく暗号論的乱数を使う**——
 * このコードだけがサーバー上の鍵を開ける材料なので、予測可能な乱数だと意味が無くなる。
 */
export function generateTransferCode(): string {
  const digits = crypto.getRandomValues(new Uint8Array(TRANSFER_CODE_DIGITS));
  return Array.from(digits, (d) => String(d % 10)).join('');
}

/** 表示用の区切り("12345678" → "1234 5678")。入力側は区切りを無視して受け取る */
export function formatTransferCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code;
}

/** 入力されたコードから数字以外を落として正規化する(空白・ハイフンを許容するため) */
export function normalizeTransferCode(input: string): string {
  return input.replace(/\D/g, '').slice(0, TRANSFER_CODE_DIGITS);
}

async function deriveCodeKey(code: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(code),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: toArrayBuffer(salt), iterations: CODE_KDF_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: AES_ALGO, length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export interface WrappedDataKey {
  /** base64。コードと合わせて鍵を導出するために使う(秘密ではない) */
  salt: string;
  /** base64。IVを先頭12バイトに連結した暗号文 */
  wrapped: string;
}

/**
 * データ鍵をコード由来の鍵で包む(サーバーへ5分だけ置く形)。
 * **サーバーに渡るのはこの2つだけ**で、DKもコードも渡らない。
 */
export async function wrapDataKey(dataKey: string, code: string): Promise<WrappedDataKey> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveCodeKey(code, salt);

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: AES_ALGO, iv }, key, new TextEncoder().encode(dataKey)),
  );

  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv, 0);
  combined.set(ciphertext, iv.length);

  return { salt: toBase64(salt), wrapped: toBase64(combined) };
}

/**
 * 包まれたデータ鍵をコードで開く。コード違い・改竄・形式不正はすべて `null`——
 * 呼び出し側は「コードが違います」と案内して再入力させる(判定はクライアント側で閉じる)。
 */
export async function unwrapDataKey(
  wrappedKey: WrappedDataKey,
  code: string,
): Promise<string | null> {
  try {
    const salt = fromBase64(wrappedKey.salt);
    const combined = fromBase64(wrappedKey.wrapped);
    if (combined.length <= IV_BYTES) return null;

    const key = await deriveCodeKey(code, salt);
    const plaintext = await crypto.subtle.decrypt(
      { name: AES_ALGO, iv: toArrayBuffer(combined.slice(0, IV_BYTES)) },
      key,
      toArrayBuffer(combined.slice(IV_BYTES)),
    );

    const dataKey = new TextDecoder().decode(plaintext);
    // 開けた中身が鍵として使える形かまで確かめる(壊れた値を保存しない)
    return (await importDataKey(dataKey)) !== null ? dataKey : null;
  } catch {
    return null;
  }
}
