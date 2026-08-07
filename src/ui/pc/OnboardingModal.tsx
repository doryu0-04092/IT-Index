import { useState } from 'react';

export interface OnboardingModalProps {
  /** dontShowAgain: 「次回から表示しない」が checked のまま閉じられたかどうか */
  onClose: (dontShowAgain: boolean) => void;
}

const STEPS = [
  {
    title: 'IT-Indexへようこそ',
    body: 'IT用語を検索し、AIに質問しながら理解を深めていくためのアプリです。基本の使い方を4つのステップで紹介します。',
  },
  {
    title: '① 検索する',
    body: '画面上部の検索欄にIT用語を入力すると、登録済みの語が一覧で出てきます。選ぶと詳細画面に移動します。',
  },
  {
    title: '② AIに質問する',
    body: '詳細画面や検索結果から「AIに聞く」を選ぶと、その語についてAIと対話できます。会話は自動では保存されません。ホーム画面の「取り込む」から単語帳に保存します。',
  },
  {
    title: '③ 別の端末とデータを揃える',
    body: 'トップナビの「連携」から、PCとAndroidを同じWi-Fiにつないでカメラで QRコードを読み取るだけで、AI補足を含む単語データを両方の端末で同じ状態にできます。',
  },
] as const;

/**
 * 初回起動時のみ表示するオンボーディング（`src/ui/onboarding.ts`でlocalStorage管理）。
 * 一度に全機能を説明せず、基本機能に絞って段階的に開示する（プログレッシブオンボーディング）。
 */
export default function OnboardingModal({ onClose }: OnboardingModalProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [dontShowAgain, setDontShowAgain] = useState(true);
  const step = STEPS[stepIndex];
  const isLast = stepIndex === STEPS.length - 1;

  function close() {
    onClose(dontShowAgain);
  }

  return (
    <div className="modal-overlay">
      <div className="modal-content onboarding-content">
        <div className="modal-header">
          <h2>{step.title}</h2>
          <button type="button" className="dismiss-error" onClick={close} aria-label="閉じる">
            ✕
          </button>
        </div>

        <p className="onboarding-body">{step.body}</p>

        <div className="onboarding-dots" aria-hidden="true">
          {STEPS.map((_, i) => (
            <span key={i} className={i === stepIndex ? 'onboarding-dot active' : 'onboarding-dot'} />
          ))}
        </div>

        <label className="onboarding-dont-show">
          <input type="checkbox" checked={dontShowAgain} onChange={(e) => setDontShowAgain(e.target.checked)} />
          次回から表示しない
        </label>

        <div className="onboarding-actions">
          <button type="button" className="btn-text" onClick={close}>
            スキップ
          </button>
          {stepIndex > 0 && (
            <button type="button" className="btn-secondary" onClick={() => setStepIndex((i) => i - 1)}>
              戻る
            </button>
          )}
          <button type="button" className="btn-primary" onClick={() => (isLast ? close() : setStepIndex((i) => i + 1))}>
            {isLast ? '始める' : '次へ'}
          </button>
        </div>
      </div>
    </div>
  );
}
