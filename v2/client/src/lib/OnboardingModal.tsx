import { useState } from 'react';

export interface OnboardingModalProps {
  /** dontShowAgain: 「次回から表示しない」がcheckedのまま閉じられたかどうか */
  onClose: (dontShowAgain: boolean) => void;
}

/**
 * 移植元: ../../../src/ui/pc/OnboardingModal.tsx。文言はv2の機能に合わせて調整する
 * (依頼者指定)。v1の③はPC/Androidの直結ペアリング(QR)だったが、v2にその機能は無く
 * サーバーリレー同期(ログイン+同期タブ)に置き換わっているため、そちらの説明に変える。
 * v1にあった非対応ブラウザバナーはこのオンボーディングに含めない(v2はモダンブラウザのみ
 * 対象という判断。最終報告に明記)。
 */
const STEPS = [
  {
    title: 'IT-Indexへようこそ',
    body: 'IT用語を検索し、AIに質問しながら理解を深めていくためのアプリです。「検索」「索引」「履歴」「同期」の4つのタブを、基本の使い方とあわせて紹介します。',
  },
  {
    title: '① 検索する',
    body: '「検索」タブの入力欄にIT用語を入力すると、登録済みの語が一覧で出てきます。選ぶと詳細画面に移動します。読み方が分からない語は「索引」タブの五十音図からも辞書内を探せます。',
  },
  {
    title: '② AIに聞く',
    body: '詳細画面や検索結果から「AIに聞く」「AIで検索」を選ぶと、その語についてAIと対話できます。会話は自動では保存されません。検索画面の「取り込み待ち」一覧から単語帳に取り込みます。',
  },
  {
    title: '③ 同期でデータを揃える',
    body: '「同期」タブでログインすると、単語帳やノートを他の端末と揃えられます。「履歴」タブでは、これまで確認した語の記録を時系列・重み付けの2つの見方で振り返れます。',
  },
] as const;

/**
 * 初回起動時のみ表示するオンボーディング(`lib/onboarding.ts`でlocalStorage管理)。
 * 一度に全機能を説明せず、基本機能に絞って段階的に開示する(プログレッシブオンボーディング。
 * v1と同じ方針)。
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
