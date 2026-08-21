/**
 * 新規登録のパスワード要件(#205)。**クライアントとサーバーの両方から使う**——
 * 画面側の検証だけでは `POST /api/auth/signup` を直接叩けば回避できるため、
 * 判定はここ1箇所に置き、両方が同じ関数を呼ぶ。
 *
 * このアプリには**パスワード再設定の導線が無い**(メールアドレスは登録するが、
 * それを使った再設定は実装していない)。再設定できない以上、登録時点で弱いものを
 * 作らせないことが実質的に唯一の防御になる。ログインに試行回数の制限も無いため、
 * その分だけここが効く。
 *
 * **検証を効かせるのは新規登録だけ。ログインでは呼ばない。**
 * 再設定できないため、既存アカウントが条件に該当していた場合に
 * 永久にログイン不能になる。ブロックリストは「弱いものを新たに作らせない」ための
 * 仕組みであって、既にあるものを追い出す仕組みではない。
 */

/** 最低文字数。既存のサーバー実装(MIN_PASSWORD_LENGTH)から据え置き */
export const PASSWORD_MIN_LENGTH = 8;

/** 画面のチェックリストに出す条件。`common`(よく使われる)は条件ではなく拒否理由なので含めない */
export interface PasswordRuleResults {
  /** PASSWORD_MIN_LENGTH 文字以上か */
  length: boolean;
  /** 英小文字を1つ以上含むか */
  lowercase: boolean;
  /** 英大文字を1つ以上含むか */
  uppercase: boolean;
  /** 数字を1つ以上含むか */
  digit: boolean;
}

export type PasswordErrorCode = 'too_short' | 'missing_character_types' | 'common_password';

export interface PasswordValidationResult {
  ok: boolean;
  code?: PasswordErrorCode;
  /** そのまま利用者に見せる日本語。サーバーのエラー応答にも使う */
  message?: string;
}

/**
 * よく使われるパスワード。**大文字小文字を無視した完全一致**で判定する(部分一致はしない)。
 *
 * NIST SP 800-63B が推奨しているのはこちらで、文字種の条件ではない。
 * 文字種の条件は利用者を `Password1` のような予測しやすい型へ収束させ、
 * 攻撃側の解析ルールが真っ先に探す領域と重なるため、単独では効果が薄い。
 *
 * **このリストの価値の大半は「文字種の条件を満たしてしまう変種」にある**
 * (`Password1` / `Qwerty123` / `Passw0rd` など)。文字種の条件だけでは絶対に落ちない層で、
 * ここを潰すために入れている。条件で既に落ちるもの(`password` / `12345678` など)も
 * 併せて載せてあるが、それらは冗長で、文字種の条件を将来外した場合の保険。
 *
 * リストはクライアントのバンドルに含まれるため中身は誰でも見られるが、
 * ブロックリストは秘匿する性質のものではない。
 */
const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  // --- 文字種の条件(大小英字+数字)を満たしてしまうもの。ここが本命 ---
  'password1',
  'password12',
  'password123',
  'password1234',
  'password2025',
  'password2026',
  'passw0rd',
  'passw0rd1',
  'passw0rd123',
  'p@ssw0rd1',
  'qwerty123',
  'qwerty1234',
  'qwertyui1',
  'qwerty2026',
  'abc12345',
  'abcd1234',
  'abcde123',
  'admin123',
  'admin1234',
  'administrator1',
  'welcome1',
  'welcome12',
  'welcome123',
  'welcome2026',
  'iloveyou1',
  'iloveyou123',
  'letmein1',
  'letmein123',
  'monkey123',
  'dragon123',
  'sunshine1',
  'sunshine123',
  'football1',
  'baseball1',
  'superman1',
  'batman123',
  'princess1',
  'michael1',
  'jennifer1',
  'shadow123',
  'master123',
  'trustno1',
  'starwars1',
  'pokemon123',
  'samsung123',
  'google123',
  'test1234',
  'testtest1',
  'user1234',
  'guest123',
  'root1234',
  'login123',
  'secret123',
  'changeme1',
  'changeme123',
  'default123',
  'summer2026',
  'winter2026',
  'spring2026',
  'autumn2026',
  'january2026',
  'computer1',
  'internet1',
  'whatever1',
  'freedom1',
  'nintendo1',
  'chocolate1',
  'butterfly1',
  'liverpool1',
  'chelsea123',
  'arsenal123',
  'asdf1234',
  'asdfghjk1',
  'zxcvbnm1',
  'zaq12wsx',
  'qazwsx123',
  '1qaz2wsx3edc',
  'aaaa1111',
  'abcd12345',
  'a1b2c3d4',
  'a1234567',
  'q1w2e3r4',
  'q1w2e3r4t5',
  'nihongo123',
  'japan2026',
  'tokyo2026',
  'sakura123',
  'yamada123',
  'tanaka123',
  'suzuki123',
  'itindex123',
  'itindex2026',

  // --- 文字種の条件で既に落ちるもの(冗長。条件を外した場合の保険) ---
  'password',
  'password!',
  '12345678',
  '123456789',
  '1234567890',
  '87654321',
  '11111111',
  '00000000',
  'qwertyui',
  'qwertyuiop',
  'asdfghjk',
  'zxcvbnm',
  'iloveyou',
  'princess',
  'sunshine',
  'football',
  'baseball',
  'basketball',
  'superman',
  'starwars',
  'whatever',
  'computer',
  'internet',
  'trustno',
  'welcome',
  'monkey',
  'dragon',
  'shadow',
  'master',
  'letmein',
  'abc123',
  'abcdefg',
  'abcdefgh',
  'freedom',
  'michael',
  'jennifer',
  'jordan23',
  'chocolate',
  'butterfly',
  'liverpool',
  'nintendo',
  'pokemon',
  'samsung',
  'google',
  'facebook',
  'twitter',
  'youtube',
  'linkedin',
  'instagram',
  'changeme',
  'default',
  'secret',
  'testtest',
  'test1234',
  'administrator',
  'nihongo',
  'sakurasakura',
  'arigatou',
  'konnichiwa',
]);

/** 条件ごとの充足状況。画面のチェックリスト表示に使う */
export function checkPasswordRules(password: string): PasswordRuleResults {
  return {
    length: password.length >= PASSWORD_MIN_LENGTH,
    lowercase: /[a-z]/.test(password),
    uppercase: /[A-Z]/.test(password),
    digit: /[0-9]/.test(password),
  };
}

/** よく使われるパスワードか。大文字小文字を無視した完全一致 */
export function isCommonPassword(password: string): boolean {
  return COMMON_PASSWORDS.has(password.toLowerCase());
}

/**
 * 新規登録で受け付けてよいか。**サーバーとクライアントで同じ判定を使う**。
 *
 * 判定順は「文字数 → 文字種 → よく使われるか」。よく使われるかを最後にするのは、
 * 短いパスワードに対して「よく使われています」と返しても直し方が分からないため
 * (先に満たすべき条件を示す)。
 */
export function validatePassword(password: string): PasswordValidationResult {
  const rules = checkPasswordRules(password);

  if (!rules.length) {
    return {
      ok: false,
      code: 'too_short',
      message: `パスワードは${PASSWORD_MIN_LENGTH}文字以上で入力してください`,
    };
  }

  if (!rules.lowercase || !rules.uppercase || !rules.digit) {
    return {
      ok: false,
      code: 'missing_character_types',
      message: 'パスワードには英大文字・英小文字・数字をそれぞれ1つ以上含めてください',
    };
  }

  if (isCommonPassword(password)) {
    return {
      ok: false,
      code: 'common_password',
      message: 'このパスワードはよく使われているため使用できません。別のパスワードを入力してください',
    };
  }

  return { ok: true };
}
