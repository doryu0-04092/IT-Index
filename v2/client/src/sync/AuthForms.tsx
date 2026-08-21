import { useState } from 'react';
import { PASSWORD_MIN_LENGTH, checkPasswordRules, validatePassword } from '@it-index/shared';
import { IME_OFF, PasswordRule } from '../lib/passwordUi';

/**
 * ログイン/新規登録フォーム(SyncScreen.tsxから抽出。設定タブ「ライセンス」のログイン誘導と
 * 同期タブで共有するため)。
 *
 * パスワード要件(#205)は**新規登録にのみ**効かせる。ログイン側で検証すると、
 * このアプリにはパスワード再設定の導線が無いため、条件に該当する既存アカウントが
 * 永久にログイン不能になる。判定はshared/core/passwordPolicyの1箇所に置き、
 * サーバー(/api/auth/signup)と同じ関数を呼ぶ——画面側だけの検証はAPIを
 * 直接叩けば回避できるので、ここはUXのための先出しであって防御の本体ではない。
 */
export default function AuthForms({
  busy,
  error,
  onSubmit,
}: {
  busy: boolean;
  error: string | null;
  onSubmit: (mode: 'signup' | 'login', email: string, password: string) => void;
}) {
  const [mode, setMode] = useState<'signup' | 'login'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showPasswordConfirm, setShowPasswordConfirm] = useState(false);

  const isSignup = mode === 'signup';
  const rules = checkPasswordRules(password);
  const policy = validatePassword(password);
  // 「よく使われる」は入力途中で出すと邪魔なので、他の条件を満たしてから出す
  const commonPasswordRejected = policy.code === 'common_password';
  const confirmMismatch = isSignup && passwordConfirm.length > 0 && password !== passwordConfirm;
  const canSubmitSignup = policy.ok && password === passwordConfirm && passwordConfirm.length > 0;
  const disabled = busy || (isSignup && !canSubmitSignup);

  /** モードを切り替えたら入力状態をリセットする(登録用の確認欄がログインに残らないように) */
  const switchMode = (next: 'signup' | 'login') => {
    setMode(next);
    setPassword('');
    setPasswordConfirm('');
    setShowPassword(false);
    setShowPasswordConfirm(false);
  };

  return (
    <section className="sync-auth">
      <div className="sync-auth-tabs" role="tablist">
        <button type="button" aria-pressed={mode === 'login'} onClick={() => switchMode('login')}>
          ログイン
        </button>
        <button type="button" aria-pressed={isSignup} onClick={() => switchMode('signup')}>
          新規登録
        </button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (disabled) return;
          onSubmit(mode, email, password);
        }}
      >
        <label htmlFor="sync-email">メールアドレス</label>
        <input
          id="sync-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          {...IME_OFF}
          inputMode="email"
          required
        />

        <label htmlFor="sync-password">パスワード</label>
        <div className="password-field">
          <input
            id="sync-password"
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            {...IME_OFF}
            aria-describedby={isSignup ? 'sync-password-rules' : undefined}
            required
          />
          <PasswordVisibilityToggle
            shown={showPassword}
            onToggle={() => setShowPassword((v) => !v)}
          />
        </div>

        {isSignup && (
          <ul id="sync-password-rules" className="password-rules">
            <PasswordRule ok={rules.length}>{PASSWORD_MIN_LENGTH}文字以上</PasswordRule>
            <PasswordRule ok={rules.uppercase}>英大文字を1つ以上</PasswordRule>
            <PasswordRule ok={rules.lowercase}>英小文字を1つ以上</PasswordRule>
            <PasswordRule ok={rules.digit}>数字を1つ以上</PasswordRule>
          </ul>
        )}

        {isSignup && commonPasswordRejected && (
          <p className="sync-error" role="alert">
            {policy.message}
          </p>
        )}

        {isSignup && (
          <>
            <label htmlFor="sync-password-confirm">パスワード(確認)</label>
            <div className="password-field">
              <input
                id="sync-password-confirm"
                type={showPasswordConfirm ? 'text' : 'password'}
                value={passwordConfirm}
                onChange={(e) => setPasswordConfirm(e.target.value)}
                {...IME_OFF}
                required
              />
              <PasswordVisibilityToggle
                shown={showPasswordConfirm}
                onToggle={() => setShowPasswordConfirm((v) => !v)}
              />
            </div>
            {confirmMismatch && (
              <p className="sync-error" role="alert">
                パスワードが一致していません
              </p>
            )}
          </>
        )}

        <button type="submit" className="btn-primary" disabled={disabled}>
          {busy ? '送信しています…' : isSignup ? '登録する' : 'ログインする'}
        </button>
        {error && <p className="sync-error">{error}</p>}
      </form>
    </section>
  );
}

/**
 * 入力中のパスワードを平文表示に切り替えるボタン。
 * **type="button" が必須**——省くとフォーム内のボタンは submit 扱いになり、
 * 目のアイコンを押しただけで登録/ログインが走る。
 */
function PasswordVisibilityToggle({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="password-toggle"
      onClick={onToggle}
      aria-label={shown ? 'パスワードを隠す' : 'パスワードを表示する'}
      aria-pressed={shown}
    >
      {shown ? '🙈' : '👁'}
    </button>
  );
}

/** 条件1行。記号だけでなくaria-labelでも充足/未充足が分かるようにする */