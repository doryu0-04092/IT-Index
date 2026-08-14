import { useEffect, useMemo, useState } from 'react';
import { computeWeights, type AskRecord, type TermRecord } from '@it-index/shared';
import { loadSessionLabelRows, type SessionLabelRow } from '../lib/chatSessionLabels';
import SessionListRow from '../lib/SessionListRow';
import type { HistoryView } from '../navigation';
import type { AsksRepository } from '../repositories/asks';
import type { ChatRepository } from '../repositories/chat';
import type { TermsRepository } from '../repositories/terms';
import type { ChatSessionRecord } from '../types';

/** 「取り込み履歴」タブの状態バッジ(v1 ../../../src/ui/pc/HistoryScreen.tsx:40-51を移植) */
function chatStatusLabel(status: ChatSessionRecord['status']): string {
  switch (status) {
    case 'open':
      return '取り込み待ち';
    case 'declined':
      return '登録しない';
    case 'committed':
      return '取り込み済み';
    case 'committing':
      return '取り込み中…';
  }
}

export interface HistoryScreenProps {
  asksRepo: AsksRepository;
  termsRepo: TermsRepository;
  chatRepo: ChatRepository;
  view: HistoryView;
  onChangeView: (view: HistoryView) => void;
  onSelectTerm: (termId: string) => void;
  /** 「取り込み履歴」タブの行タップで、単語詳細ではなく取り込み前後のチャットを開く */
  onOpenChatSession: (sessionId: string) => void;
  /** 「取り込み履歴」タブの「取り込む」。SearchScreenの個別「取り込む」と同じ処理を再利用する */
  onCommitPending: (sessionId: string) => void;
}

const TABS: readonly { view: HistoryView; label: string }[] = [
  { view: 'timeline', label: '時系列' },
  { view: 'weighted', label: '重み付け' },
  { view: 'commits', label: '取り込み履歴' },
];

/**
 * 「履歴」タブ。重み付けは個人的に作った特殊な機能の1つに過ぎず、履歴としては
 * 時系列順が最低限の機能であるため(本人指定)、時系列を既定サブタブ・重み付けを
 * 2番目のサブタブとする。
 *
 * 「取り込み履歴」タブ(本人指定「検索機能周りに関してはV1を踏襲」)は、AIチャットの記録
 * (v1 ../../../src/ui/pc/HistoryScreen.tsx:64-69・270-294のcommitsタブを移植)。
 * 取り込み待ち(open)・登録しない(declined)・取り込み済み(committed)・取り込み中
 * (committing)のすべてを最終やり取り日時(lastActiveAt)の降順で時系列に並べる
 * ——v1同様、状態で絞り込まない。行にはラベルの他に状態バッジ(chatStatusLabel)と日時を
 * 添え、タップでそのチャットを開く。「取り込む」ボタンはopen/declinedの行にだけ出す
 * (v1:283準拠。committedは既に反映済み、committingは処理中のため出さない)。
 * 連携履歴・競合選択タブは将来ここにサブタブとして追加できるが、現時点では実装しない
 * (要件外)。
 *
 * データ取得(asks・term引き当て)はサブタブ間で共通・1回だけ行う(旧WeightedScreen.tsxの
 * ロードを移植)。並べ替え・表示だけをサブタブごとに分ける。tombstone(削除済み)の語は
 * termsRepo.getAll()が非削除のみ返すため自然に除外される。
 */
export default function HistoryScreen({
  asksRepo,
  termsRepo,
  chatRepo,
  view,
  onChangeView,
  onSelectTerm,
  onOpenChatSession,
  onCommitPending,
}: HistoryScreenProps) {
  const [asks, setAsks] = useState<AskRecord[]>([]);
  const [termsById, setTermsById] = useState<Map<string, TermRecord>>(new Map());
  const [commitRows, setCommitRows] = useState<SessionLabelRow[] | null>(null);

  useEffect(() => {
    void (async () => {
      setAsks(await asksRepo.getAllOrdered());
      const terms = await termsRepo.getAll();
      setTermsById(new Map(terms.map((t) => [t.id, t])));

      // 「取り込み履歴」タブ用。open/declined/committed/committingの全ステータスを対象にする
      // (上のコメント参照)。getRecentSessionsが既にlastActiveAt降順で返す。
      const sessions = await chatRepo.getRecentSessions(30);
      setCommitRows(await loadSessionLabelRows(chatRepo, termsRepo, sessions));
    })();
  }, [asksRepo, termsRepo, chatRepo]);

  // 取り込みはバックグラウンドで進む(App.tsx側)。押した時点でこの一覧からは消してよい
  // (SearchScreen.tsxのhandleCommitPendingと同じ理由)。
  function handleCommitPending(sessionId: string) {
    onCommitPending(sessionId);
    setCommitRows((prev) => prev?.filter((r) => r.session.id !== sessionId) ?? prev);
  }

  const weightedRows = useMemo(
    () =>
      computeWeights(asks)
        .map((w) => ({ term: termsById.get(w.termId), weight: w.weight }))
        .filter((r): r is { term: TermRecord; weight: number } => r.term !== undefined),
    [asks, termsById],
  );

  // 同じ語を複数回聞いた場合、時系列ビューには最新の1件だけを表示する
  // (履歴の各行が独立した出来事ではなく「その語を最後にいつ聞いたか」を示す一覧のため。
  // v1 ../../../it-index/src/ui/pc/HistoryScreen.tsx の時系列ビューを移植)。
  const timelineRows = useMemo(() => {
    const latestByTerm = new Map<string, AskRecord>();
    for (const ask of asks) {
      const existing = latestByTerm.get(ask.termId);
      if (!existing || ask.at > existing.at) {
        latestByTerm.set(ask.termId, ask);
      }
    }
    return [...latestByTerm.values()]
      .map((ask) => ({ ask, term: termsById.get(ask.termId) }))
      .filter((r): r is { ask: AskRecord; term: TermRecord } => r.term !== undefined)
      .sort((a, b) => b.ask.at - a.ask.at);
  }, [asks, termsById]);

  return (
    <div className="history-screen">
      <nav className="app-nav" aria-label="履歴の切り替え">
        {TABS.map((tab) => (
          <button
            key={tab.view}
            type="button"
            className={view === tab.view ? 'app-nav-link app-nav-link-active' : 'app-nav-link'}
            onClick={() => onChangeView(tab.view)}
            aria-current={view === tab.view ? 'page' : undefined}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {view === 'timeline' ? (
        <>
          {timelineRows.length === 0 && <p className="status-text">まだ記録がありません。</p>}
          <ul className="result-list">
            {timelineRows.map(({ ask, term }) => (
              <li key={ask.id} className="result-row">
                <button type="button" className="result-button" onClick={() => onSelectTerm(term.id)}>
                  <span className="result-term">{term.term}</span>
                  <span className="result-field">{new Date(ask.at).toLocaleString('ja-JP')}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : view === 'weighted' ? (
        <>
          <p className="status-text">最近も繰り返し聞いている語ほど上位(=まだ定着していない語)</p>
          {weightedRows.length === 0 && <p className="status-text">まだ記録がありません。</p>}
          <ul className="result-list">
            {weightedRows.map(({ term, weight }) => (
              <li key={term.id} className="result-row">
                <button type="button" className="result-button" onClick={() => onSelectTerm(term.id)}>
                  <span className="result-term">{term.term}</span>
                  <span className="result-reading">{term.readings[0]}</span>
                  <span className="result-score">{weight.toFixed(2)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          {commitRows !== null && commitRows.length === 0 && <p className="status-text">まだ記録がありません。</p>}
          <ul className="result-list">
            {commitRows?.map((row) => (
              <SessionListRow
                key={row.session.id}
                row={row}
                onSelect={() => onOpenChatSession(row.session.id)}
                meta={<span className="result-field">{chatStatusLabel(row.session.status)}</span>}
              >
                {(row.session.status === 'open' || row.session.status === 'declined') && (
                  <button
                    type="button"
                    className="btn-secondary search-pending-commit"
                    onClick={() => handleCommitPending(row.session.id)}
                  >
                    取り込む
                  </button>
                )}
              </SessionListRow>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
