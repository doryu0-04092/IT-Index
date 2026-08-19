import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiRequestError } from '../sync/apiClient';
import CheckoutScreen, { type CheckoutScreenProps } from './CheckoutScreen';

/**
 * savePaymentMethodは常にspyで包んで返す(overridesは中身の実装だけを差し替える)。
 * お支払い方法がサーバーへ渡ったか・渡らなかったかの検証に使う。
 *
 * 購入(intent='purchase')はカード入力の前に説明ステップ(intro)が挟まる(#151)ため、
 * フォームを対象とする既存テストのために既定でintroを通過させる。intro自体を
 * 検証するテストは stayOnIntro: true を渡す。
 */
function renderCheckout(
  overrides: Partial<CheckoutScreenProps> = {},
  { stayOnIntro = false }: { stayOnIntro?: boolean } = {},
) {
  const { savePaymentMethod: saveImpl, ...rest } = overrides;
  const savePaymentMethod = vi.fn<CheckoutScreenProps['savePaymentMethod']>(
    saveImpl ?? (() => Promise.resolve()),
  );
  const props: CheckoutScreenProps = {
    intent: 'purchase',
    onBack: () => {},
    processPayment: () => Promise.resolve({ code: 'ABCD-1234', activatedAt: 1000 }),
    savePaymentMethod,
    processingMinDelayMs: 0,
    ...rest,
  };
  render(<CheckoutScreen {...props} />);
  if (props.intent === 'purchase' && !stayOnIntro) {
    fireEvent.click(screen.getByRole('button', { name: 'カード入力へ進む' }));
  }
  return { savePaymentMethod };
}

/** 全欄に正しい値を入れる(4242…はVisaとしてブランド判定される16桁) */
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
    // 桁不足はエラー(Luhn廃止(#139)後も桁数チェックは残る)
    fireEvent.change(cardInput, { target: { value: '42424242' } });
    // blur前はエラーを出さない(入力途中に騒がない)
    expect(screen.queryByText('カード番号が正しくありません')).toBeNull();

    fireEvent.blur(cardInput);
    expect(screen.getByText('カード番号が正しくありません')).toBeTruthy();
  });

  it('モック注記の下に実カード番号を登録しない注意書きを出す(本人指定)', () => {
    renderCheckout();
    expect(screen.getByText('実際のクレジットカード番号は登録しないでください')).toBeTruthy();
  });

  it('購入成功: 完了画面にコードを表示し、お支払い方法(下4桁のみ)をサーバーへ保存する', async () => {
    const { savePaymentMethod } = renderCheckout();
    fillValidCard();

    fireEvent.click(payButton());

    await waitFor(() => expect(screen.getByTestId('license-code').textContent).toBe('ABCD-1234'));
    expect(screen.getByText('お支払いが完了しました')).toBeTruthy();

    expect(savePaymentMethod).toHaveBeenCalledWith({
      brand: 'visa',
      last4: '4242',
      expiry: '12/99',
      holderName: 'TARO YAMADA',
    });
    // 完全なカード番号・CVCは送らないし、端末にも残さない
    expect(JSON.stringify(savePaymentMethod.mock.calls)).not.toContain('4242424242424242');
    expect(JSON.stringify(localStorage)).not.toContain('4242424242424242');
  });

  it('購入は成功したがカード保存に失敗した場合、購入自体は完了として扱う', async () => {
    // ライセンスは発行済みなのでコードを見せないと利用者が損をする。カードは設定タブから入れ直せる
    const { savePaymentMethod } = renderCheckout({
      savePaymentMethod: () =>
        Promise.reject(new ApiRequestError({ code: 'network_error', message: '保存できません' }, 0)),
    });
    fillValidCard();

    fireEvent.click(payButton());

    await waitFor(() => expect(screen.getByTestId('license-code').textContent).toBe('ABCD-1234'));
    expect(savePaymentMethod).toHaveBeenCalled();
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

  it('決済失敗時はフォームに戻ってエラーを表示し、カードも保存しない', async () => {
    const { savePaymentMethod } = renderCheckout({
      processPayment: () =>
        Promise.reject(new ApiRequestError({ code: 'network_error', message: 'サーバーに接続できませんでした' }, 0)),
    });
    fillValidCard();

    fireEvent.click(payButton());

    await waitFor(() => expect(screen.getByText('サーバーに接続できませんでした')).toBeTruthy());
    expect(payButton()).toBeTruthy(); // フォームへ戻っている
    expect(savePaymentMethod).not.toHaveBeenCalled();
  });

  it('カード変更モード: 課金処理を呼ばず、お支払い方法だけをサーバーへ保存する', async () => {
    const processPayment = vi.fn();
    const { savePaymentMethod } = renderCheckout({ intent: 'change-card', processPayment });

    expect(screen.getByText('お支払い方法の変更')).toBeTruthy();
    fillValidCard();

    fireEvent.click(screen.getByRole('button', { name: 'このカードに変更する' }));

    await waitFor(() => expect(screen.getByText('お支払い方法を変更しました')).toBeTruthy());
    expect(processPayment).not.toHaveBeenCalled();
    expect(savePaymentMethod).toHaveBeenCalledWith(
      expect.objectContaining({ last4: '4242', brand: 'visa' }),
    );
  });

  it('カード変更の保存に失敗したら成功表示にせず、フォームへ戻してエラーを出す', async () => {
    renderCheckout({
      intent: 'change-card',
      savePaymentMethod: () =>
        Promise.reject(new ApiRequestError({ code: 'license_required', message: 'ライセンスが必要です' }, 403)),
    });
    fillValidCard();

    fireEvent.click(screen.getByRole('button', { name: 'このカードに変更する' }));

    await waitFor(() => expect(screen.getByText('ライセンスが必要です')).toBeTruthy());
    expect(screen.queryByText('お支払い方法を変更しました')).toBeNull();
    expect(screen.getByRole('button', { name: 'このカードに変更する' })).toBeTruthy();
  });

  it('購入時: カード入力の前に月額サブスクの説明を表示する(#151)', () => {
    renderCheckout({}, { stayOnIntro: true });

    // 月額制であることと、購入で使えるようになる機能を明示する
    expect(screen.getByText('月額制のサブスクリプション')).toBeTruthy();
    expect(screen.getByText('購入すると使えるようになる機能')).toBeTruthy();
    expect(screen.getByText('端末間同期')).toBeTruthy();
    expect(screen.getByText('APIキーなしでのAI利用')).toBeTruthy();
    expect(screen.getByText('モック決済です。実際の課金は発生しません')).toBeTruthy();
    // 説明の段階ではカード入力を出さない
    expect(screen.queryByLabelText('カード番号')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'カード入力へ進む' }));
    expect(screen.getByLabelText('カード番号')).toBeTruthy();
  });

  it('カード変更モードでは説明ステップを出さず、直接フォームから始める', () => {
    renderCheckout({ intent: 'change-card' });

    expect(screen.getByLabelText('カード番号')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'カード入力へ進む' })).toBeNull();
  });

  it('購入時の戻る: 説明ではonBack、フォームでは説明へ戻る', () => {
    const onBack = vi.fn();
    renderCheckout({ onBack }, { stayOnIntro: true });

    // フォームへ進んでから戻ると説明に戻る(設定タブへは飛ばない)
    fireEvent.click(screen.getByRole('button', { name: 'カード入力へ進む' }));
    fireEvent.click(screen.getByRole('button', { name: '← 戻る' }));
    expect(onBack).not.toHaveBeenCalled();
    expect(screen.getByText('購入すると使えるようになる機能')).toBeTruthy();

    // 説明で戻ると設定タブへ(onBack)
    fireEvent.click(screen.getByRole('button', { name: '← 戻る' }));
    expect(onBack).toHaveBeenCalled();
  });

  it('カード変更モードの戻るはonBackを呼ぶ', () => {
    const onBack = vi.fn();
    renderCheckout({ intent: 'change-card', onBack });

    fireEvent.click(screen.getByRole('button', { name: '← 戻る' }));
    expect(onBack).toHaveBeenCalled();
  });
});
