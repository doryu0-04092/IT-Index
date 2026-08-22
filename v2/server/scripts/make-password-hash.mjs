/**
 * パスワードのハッシュを作る（復旧用。#223）。
 *
 * **なぜ要るか。** このアプリには「ログインできない状態からの再設定」の導線が無い
 * （設定画面のパスワード変更(#220)は**ログイン中**にしか使えない）。全端末でログインできなく
 * なった場合、アカウントを取り戻す手段が他に無い——ライセンスはアカウントに紐づき、
 * 同期データはサーバー上では暗号化されていて運営者にも中身は戻せない。
 *
 * 実際に近いところまで行った事例がある（2026-08-22。Androidのキーボードによる入力の
 * 書き換えでログインできなくなり、PC版で入れたため助かった）。その時「D1をクリアするしかないのでは」
 * という案が出た——**クリアするとライセンスまで消える。** そうならないための逃げ道がこれ。
 *
 * **アプリ側(server/src/crypto.ts)と同じ形式で作る。** 形式を変えると検証に通らない:
 *   "pbkdf2:<iterations>:<base64 salt>:<base64 hash>"
 * 値を変える時は crypto.ts と一緒に直すこと（ここだけ変えると復旧できないハッシュができる）。
 *
 * 使い方:
 *   node scripts/make-password-hash.mjs '新しいパスワード'
 *
 * 出力されたハッシュを D1 の accounts.password_hash へ入れる。手順は
 * docs/v2/deploy.md「ログインできなくなった時の復旧」を参照。
 */
import { webcrypto } from 'node:crypto';

// server/src/crypto.ts と同じ値。片方だけ変えないこと
const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_LENGTH_BITS = 256;

function toBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

async function hashPassword(password) {
  const salt = webcrypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const keyMaterial = await webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const derived = await webcrypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    KEY_LENGTH_BITS,
  );
  return `pbkdf2:${ITERATIONS}:${toBase64(salt)}:${toBase64(new Uint8Array(derived))}`;
}

const password = process.argv[2];
if (typeof password !== 'string' || password === '') {
  console.error('使い方: node scripts/make-password-hash.mjs \'新しいパスワード\'');
  console.error('');
  console.error('パスワードはシェルの履歴に残る。復旧後は履歴を消すか、使い捨ての値にしてから');
  console.error('アプリの設定画面(#220)で本来のパスワードへ変更すること。');
  process.exit(1);
}

console.log(await hashPassword(password));
