import type { ReactNode } from 'react';

/**
 * パスワード入力まわりの共通部品。**設定画面(パスワード変更)と認証フォームの2箇所で使う**ため、
 * `sync/AuthForms.tsx` から切り出した。
 */

/**
 * スマートフォンのキーボードによる書き換えを止める(#213)。
 *
 * **なぜ必要か。** Androidのキーボードは入力欄の先頭を大文字にしたり、綴りを直したりする。
 * メールアドレスが `Foo@…` になるとサーバーの照合に掛からず、パスワードも1文字違えば通らない。
 * PCでは起きないため、**「PCでは入れるのに端末では弾かれる」**という分かりにくい形で出る
 * (2026-08-22に実際に報告され、0.4.5で修正した)。
 *
 * **パスワード欄にも必要。** 伏せ字(`type="password"`)の間はキーボードも余計なことをしないが、
 * 入力内容を表示する切り替えで `type="text"` に変わった瞬間、ただの文章入力として扱われる。
 */
export const IME_OFF = {
  autoCapitalize: 'none',
  autoCorrect: 'off',
  spellCheck: false,
} as const;

/** パスワード要件のチェックリスト1行(#205)。満たしているかを入力しながら見せる */
export function PasswordRule({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className={ok ? 'password-rule-ok' : 'password-rule-todo'}>
      <span aria-hidden="true">{ok ? '✓' : '・'}</span>
      <span>{children}</span>
      <span className="visually-hidden">{ok ? '(条件を満たしています)' : '(未入力です)'}</span>
    </li>
  );
}
