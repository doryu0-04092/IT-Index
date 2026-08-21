import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import AuthForms from './AuthForms';

// パスワード要件(#205)。判定そのものは shared/core/passwordPolicy のテストで確かめてあるので、
// ここでは「画面がその判定をどう見せ、いつ送信させるか」だけを検証する。
// 防御の本体はサーバー(/api/auth/signup)側で、ここはUXのための先出し。

function setup(onSubmit = vi.fn()) {
  render(<AuthForms busy={false} error={null} onSubmit={onSubmit} />);
  return onSubmit;
}

function openSignup() {
  fireEvent.click(screen.getByRole('button', { name: '新規登録' }));
}

function typePassword(value: string) {
  fireEvent.change(screen.getByLabelText('パスワード'), { target: { value } });
}

function typeConfirm(value: string) {
  fireEvent.change(screen.getByLabelText('パスワード(確認)'), { target: { value } });
}

function submitButton() {
  return screen.getByRole('button', { name: /登録する|ログインする|送信しています/ });
}

describe('AuthForms', () => {
  afterEach(cleanup);

  describe('新規登録', () => {
    it('条件のチェックリストを表示する', () => {
      setup();
      openSignup();

      expect(screen.getByText('8文字以上')).toBeTruthy();
      expect(screen.getByText('英大文字を1つ以上')).toBeTruthy();
      expect(screen.getByText('英小文字を1つ以上')).toBeTruthy();
      expect(screen.getByText('数字を1つ以上')).toBeTruthy();
    });

    it('満たした条件の行だけが充足の見た目になる', () => {
      setup();
      openSignup();
      typePassword('abcdefghij'); // 8文字以上・小文字のみ

      expect(screen.getByText('8文字以上').closest('li')?.className).toBe('password-rule-ok');
      expect(screen.getByText('英小文字を1つ以上').closest('li')?.className).toBe('password-rule-ok');
      expect(screen.getByText('英大文字を1つ以上').closest('li')?.className).toBe('password-rule-todo');
      expect(screen.getByText('数字を1つ以上').closest('li')?.className).toBe('password-rule-todo');
    });

    it('条件を満たしていない間は送信できない', () => {
      const onSubmit = setup();
      openSignup();
      typePassword('abcdefghij'); // 大文字・数字なし
      typeConfirm('abcdefghij');

      expect(submitButton().hasAttribute('disabled')).toBe(true);
      fireEvent.click(submitButton());
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('確認欄が一致しない間は送信できず、理由を表示する', () => {
      const onSubmit = setup();
      openSignup();
      typePassword('Kaisya2026x');
      typeConfirm('Kaisya2026y');

      expect(screen.getByText('パスワードが一致していません')).toBeTruthy();
      expect(submitButton().hasAttribute('disabled')).toBe(true);
      fireEvent.click(submitButton());
      expect(onSubmit).not.toHaveBeenCalled();
    });

    // ブロックリストの本命。文字種の条件は満たしてしまうため、ここでしか止められない
    it('よく使われるパスワードは、条件を満たしていても弾いて理由を表示する', () => {
      const onSubmit = setup();
      openSignup();
      typePassword('Password1');
      typeConfirm('Password1');

      expect(screen.getByText(/よく使われている/)).toBeTruthy();
      expect(submitButton().hasAttribute('disabled')).toBe(true);
      fireEvent.click(submitButton());
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('すべて満たして一致すれば送信できる', () => {
      const onSubmit = setup();
      openSignup();
      fireEvent.change(screen.getByLabelText('メールアドレス'), {
        target: { value: 'user@example.com' },
      });
      typePassword('Kaisya2026x');
      typeConfirm('Kaisya2026x');

      expect(submitButton().hasAttribute('disabled')).toBe(false);
      fireEvent.click(submitButton());
      expect(onSubmit).toHaveBeenCalledWith('signup', 'user@example.com', 'Kaisya2026x');
    });
  });

  describe('ログイン', () => {
    // 回帰防止。ログイン側で要件を検証すると、パスワード再設定の導線が無いこのアプリでは
    // 条件に該当する既存アカウントが永久にログイン不能になる。
    it('要件を満たさないパスワードでも送信できる(ログインでは検証しない)', () => {
      const onSubmit = setup();
      fireEvent.change(screen.getByLabelText('メールアドレス'), {
        target: { value: 'legacy@example.com' },
      });
      typePassword('password123'); // 新規登録では弾かれる値

      expect(submitButton().hasAttribute('disabled')).toBe(false);
      fireEvent.click(submitButton());
      expect(onSubmit).toHaveBeenCalledWith('login', 'legacy@example.com', 'password123');
    });

    it('条件のチェックリストも確認欄も出さない', () => {
      setup();
      expect(screen.queryByText('8文字以上')).toBeNull();
      expect(screen.queryByLabelText('パスワード(確認)')).toBeNull();
    });
  });

  describe('表示の切り替え', () => {
    it('目のボタンで平文表示に切り替わる', () => {
      setup();
      const input = screen.getByLabelText('パスワード');
      expect(input.getAttribute('type')).toBe('password');

      fireEvent.click(screen.getByRole('button', { name: 'パスワードを表示する' }));
      expect(input.getAttribute('type')).toBe('text');

      fireEvent.click(screen.getByRole('button', { name: 'パスワードを隠す' }));
      expect(input.getAttribute('type')).toBe('password');
    });

    // type="button" を省くとフォーム内のボタンはsubmit扱いになり、
    // 目のアイコンを押しただけで登録/ログインが走ってしまう
    it('目のボタンを押してもフォームは送信されない', () => {
      const onSubmit = setup();
      fireEvent.change(screen.getByLabelText('メールアドレス'), {
        target: { value: 'user@example.com' },
      });
      typePassword('Kaisya2026x');

      fireEvent.click(screen.getByRole('button', { name: 'パスワードを表示する' }));
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('確認欄は本欄と独立して切り替えられる', () => {
      setup();
      openSignup();
      const toggles = screen.getAllByRole('button', { name: 'パスワードを表示する' });
      expect(toggles).toHaveLength(2);

      fireEvent.click(toggles[1]);
      expect(screen.getByLabelText('パスワード(確認)').getAttribute('type')).toBe('text');
      expect(screen.getByLabelText('パスワード').getAttribute('type')).toBe('password');
    });
  });

  it('タブを切り替えると入力中のパスワードを持ち越さない', () => {
    setup();
    openSignup();
    typePassword('Kaisya2026x');

    fireEvent.click(screen.getByRole('button', { name: 'ログイン' }));
    expect((screen.getByLabelText('パスワード') as HTMLInputElement).value).toBe('');
  });
});
