import { useState } from 'react';
import Sheet from './Sheet';

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
    body: '詳細画面や検索結果から「AIに聞く」を選ぶと、その語についてAIと対話できます。会話は「確定する」を押すまで保存されません。',
  },
  {
    title: '③ ローカルフォルダと同期する',
    body: '設定（画面左下の⚙）から、Claude Codeなどで編集できるローカルフォルダを作成できます。フォルダ内のファイルを直接編集して取り込むこともできます。',
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
    // 背景を押しても閉じない。最初に読んでほしい案内なので、誤タップで消えないようにする
    <Sheet title={step.title} onClose={close} dismissOnScrim={false}>
      <div className="onboarding-content">
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
    </Sheet>
  );
}
