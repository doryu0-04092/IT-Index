import { useState } from 'react';
import { applyDistribution, type DistributionProposal } from '../../ai/distribution';
import type { AsksRepository } from '../../repositories/asks';
import type { ChatRepository } from '../../repositories/chat';
import type { NotesRepository } from '../../repositories/notes';
import type { TermsRepository } from '../../repositories/terms';

export interface ApprovalScreenProps {
  proposal: DistributionProposal;
  termsRepo: TermsRepository;
  notesRepo: NotesRepository;
  asksRepo: AsksRepository;
  chatRepo: ChatRepository;
  deviceId: string;
  onDone: () => void;
}

/**
 * docs/architecture.md §5 の approving 状態。
 * 承認 = applyDistribution() を呼ぶ（DBへ書き込む唯一の経路）。
 * 却下 = 何もせず戻る（会話は open のまま残る。要件定義書§5.3）。
 */
export default function ApprovalScreen({
  proposal,
  termsRepo,
  notesRepo,
  asksRepo,
  chatRepo,
  deviceId,
  onDone,
}: ApprovalScreenProps) {
  const [checked, setChecked] = useState<Set<string>>(() => new Set(proposal.proposedTerms.map((t) => t.termId)));
  const [applying, setApplying] = useState(false);

  function toggle(termId: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(termId)) next.delete(termId);
      else next.add(termId);
      return next;
    });
  }

  async function handleApprove() {
    setApplying(true);
    await applyDistribution(proposal, checked, { termsRepo, notesRepo, asksRepo, chatRepo, deviceId });
    setApplying(false);
    onDone();
  }

  if (proposal.proposedTerms.length === 0) {
    return (
      <div className="approval-screen">
        <p className="search-status">IT用語は見つかりませんでした。</p>
        <button type="button" onClick={onDone}>
          戻る
        </button>
      </div>
    );
  }

  return (
    <div className="approval-screen">
      <h2>分配統合の確認</h2>
      <p className="search-status">チェックした語だけがAI補足に反映されます。</p>

      <ul className="approval-list">
        {proposal.proposedTerms.map((t) => (
          <li key={t.termId} className="approval-item">
            <label className="approval-item-header">
              <input type="checkbox" checked={checked.has(t.termId)} onChange={() => toggle(t.termId)} />
              <span className="approval-term">{t.term}</span>
              {t.isNewTerm && <span className="approval-new-badge">新規語</span>}
              <span className="approval-field">{t.field}</span>
            </label>
            <p className="approval-body">{t.finalBody}</p>
          </li>
        ))}
      </ul>

      <div className="approval-actions">
        <button type="button" onClick={onDone} disabled={applying}>
          却下
        </button>
        <button type="button" onClick={handleApprove} disabled={applying || checked.size === 0}>
          {applying ? '反映中…' : `承認する（${checked.size}件）`}
        </button>
      </div>
    </div>
  );
}
