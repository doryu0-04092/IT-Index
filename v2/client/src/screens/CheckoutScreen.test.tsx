import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiRequestError } from '../sync/apiClient';
import CheckoutScreen, { type CheckoutScreenProps } from './CheckoutScreen';

function renderCheckout(overrides: Partial<CheckoutScreenProps> = {}) {
  const props: CheckoutScreenProps = {
    intent: 'purchase',
    onBack: () => {},
    processPayment: () => Promise.resolve({ code: 'ABCD-1234', activatedAt: 1000 }),
    processingMinDelayMs: 0,
    ...overrides,
  };
  render(<CheckoutScreen {...props} />);
}

/** 全欄に正しい値を入れる(4242…はLuhnが通るVisaのテスト番号) */
function fillValidCard() {
  fireEvent.change(screen.getByLabelText('カード番号'), { target: { value: '4242424242424242' } });
  fireEvent.change(screen.getByLabelText('有効期限(月/年)'), { target: { value: '1299' } });
  fireEvent.change(screen.getByLabelText('セキュリティコード'), { target: { value: '123' } });
  fireEvent.change(screen.getByLabelText('カード名義'), { target: { value: 'TARO YAMADA' } });
}

function payButton() {
  return screen.getByRole('button', { name: '¥300 を支払う' }) as HTMLButtonElement;
}

describe('CheckoutScreen', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('全欄が正しく入力されるまで支払いボタンは非活性', () => {
    renderCheckout();

    expect(payButton().disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('カード番号'), { target: { value: '4242424242424242' } });
    fireEvent.change(screen.getByLabelText('有効期限(月/年)'), { target: { value: '1299' } });
    fireEvent.change(screen.getByLabelText('セキュリティコード'), { target: { value: '123' } });
    expect(payButton().disabled).toBe(true); // 名義がまだ

    fireEvent.change(screen.getByLabelText('カード名義'), { target: { value: 'TARO YAMADA' } });
    expect(payButton().disabled).toBe(false);
  });

  it('カード番号は自動整形され、ブランドバッジと形式プレースホルダーが出る', () => {
    renderCheckout();

    const cardInput = screen.getByLabelText('カード番号') as HTMLInputElement;
    expect(cardInput.placeholder).toBe('XXXX XXXX XXXX XXXX');
    expect((screen.getByLabelText('有効期限(月/年)') as HTMLInputElement).placeholder).toBe('XX/XX');

    fireEvent.change(cardInput, { target: { value: '4242424242424242' } });
    expect(cardInput.value).toBe('4242 4242 4242 4242');
    expect(screen.getByText('VISA')).toBeTruthy();
  });

  it('不正なカード番号はblur後にエラーを表示する', () => {
    renderCheckout();

    const cardInput = screen.getByLabelText('カード番号');
    fireEvent.change(cardInput, { target: { value: '4242424242424241' } });
    // blur前はエラーを出さない(入力途中に騒がない)
    expect(screen.queryByText('カード番号が正しくありません')).toBeNull();

    fireEvent.blur(cardInput);
    expect(screen.getByText('カード番号が正しくありません')).toBeTruthy();
  });

  it('モック注記の下に実カード番号を登録しない注意書きを出す(本人指定)', () => {
    renderCheckout();
    expect(screen.getByText('実際のクレジットカード番号は登録しないでください')).toBeTruthy();
  });

  it('購入成功: 完了画面にコードを表示し、コードとお支払い方法(下4桁のみ)を端末内保存する', async () => {
    renderCheckout();
    fillValidCard();

    fireEvent.click(payButton());

    await waitFor(() => expect(screen.getByTestId('license-code').textContent).toBe('ABCD-1234'));
    expect(screen.getByText('お支払いが完了しました')).toBeTruthy();

    expect(localStorage.getItem('it-index-v2:license-code')).toBe('ABCD-1234');
    const stored = JSON.parse(localStorage.getItem('it-index-v2:mock-payment-method') ?? 'null') as {
      brand: string;
      last4: string;
      expiry: string;
      holderName: string;
    };
    expect(stored).toEqual({ brand: 'visa', last4: '4242', expiry: '12/99', holderName: 'TARO YAMADA' });
    // 完全なカード番号・CVCはどのキーにも保存しない
    expect(JSON.stringify(localStorage)).not.toContain('4242424242424242');
  });

  it('既にライセンスがある場合(409)は専用の文言に切り替える', async () => {
    renderCheckout({
      processPayment: () =>
        Promise.reject(
          new ApiRequestError({ code: 'license_already_active', message: '既に有効なライセンスがあります' }, 409),
        ),
    });
    fillValidCard();

    fireEvent.click(payButton());

    await waitFor(() => expect(screen.getByText('既にライセンスがあります')).toBeTruthy());
  });

  it('決済失敗時はフォームに戻ってエラーを表示し、端末内保存は書かない', async () => {
    renderCheckout({
      processPayment: () =>
        Promise.reject(new ApiRequestError({ code: 'network_error', message: 'サーバーに接続できませんでした' }, 0)),
    });
    fillValidCard();

    fireEvent.click(payButton());

    await waitFor(() => expect(screen.getByText('サーバーに接続できませんでした')).toBeTruthy());
    expect(payButton()).toBeTruthy(); // フォームへ戻っている
    expect(localStorage.getItem('it-index-v2:license-code')).toBeNull();
    expect(localStorage.getItem('it-index-v2:mock-payment-method')).toBeNull();
  });

  it('カード変更モード: 課金処理を呼ばず、お支払い方法だけを上書き保存する', async () => {
    const processPayment = vi.fn();
    renderCheckout({ intent: 'change-card', processPayment });

    expect(screen.getByText('お支払い方法の変更')).toBeTruthy();
    fillValidCard();

    fireEvent.click(screen.getByRole('button', { name: 'このカードに変更する' }));

    await waitFor(() => expect(screen.getByText('お支払い方法を変更しました')).toBeTruthy());
    expect(processPayment).not.toHaveBeenCalled();
    expect(localStorage.getItem('it-index-v2:license-code')).toBeNull();
    const stored = JSON.parse(localStorage.getItem('it-index-v2:mock-payment-method') ?? 'null') as {
      last4: string;
    };
    expect(stored.last4).toBe('4242');
  });

  it('戻るでonBackを呼ぶ', () => {
    const onBack = vi.fn();
    renderCheckout({ onBack });

    fireEvent.click(screen.getByRole('button', { name: '← 戻る' }));
    expect(onBack).toHaveBeenCalled();
  });
});
