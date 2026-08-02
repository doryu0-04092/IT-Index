import { useState } from 'react';
import { hasSeenHint, markHintSeen } from '../featureHints';

export interface FeatureHintProps {
  /** localStorageで既読状態を管理するためのキー（機能ごとに一意） */
  hintKey: string;
  children: string;
}

/**
 * 機能を実際に使うタイミングでその場に出す、段階的オンボーディング（プログレッシブオンボーディング）の案内。
 * 「わかった」を押すと`src/ui/featureHints.ts`で既読を記録し、以後は表示しない。
 */
export default function FeatureHint({ hintKey, children }: FeatureHintProps) {
  const [dismissed, setDismissed] = useState(() => hasSeenHint(hintKey));

  if (dismissed) return null;

  return (
    <div className="feature-hint">
      <p>{children}</p>
      <button
        type="button"
        className="btn-text"
        onClick={() => {
          markHintSeen(hintKey);
          setDismissed(true);
        }}
      >
        わかった
      </button>
    </div>
  );
}
