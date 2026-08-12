import { useState } from 'react';

/**
 * ログイン/新規登録フォーム(SyncScreen.tsxから抽出。設定タブ「ライセンス」のログイン誘導と
 * 同期タブで共有するため。挙動は移設前から変更していない)。
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

  return (
    <section className="sync-auth">
      <div className="sync-auth-tabs" role="tablist">
        <button type="button" aria-pressed={mode === 'login'} onClick={() => setMode('login')}>
          ログイン
        </button>
        <button type="button" aria-pressed={mode === 'signup'} onClick={() => setMode('signup')}>
          新規登録
        </button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(mode, email, password);
        }}
      >
        <label htmlFor="sync-email">メールアドレス</label>
        <input
          id="sync-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <label htmlFor="sync-password">パスワード</label>
        <input
          id="sync-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? '送信しています…' : mode === 'signup' ? '登録する' : 'ログインする'}
        </button>
        {error && <p className="sync-error">{error}</p>}
      </form>
    </section>
  );
}
