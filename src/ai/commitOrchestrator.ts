import type { AsksRepository } from '../repositories/asks';
import type { ChatRepository } from '../repositories/chat';
import type { NotesRepository } from '../repositories/notes';
import type { TermsRepository } from '../repositories/terms';
import type { AiClient } from './aiClient';
import { autoApplyAskedTerms, proposeDistribution, type DistributionProposal } from './distribution';

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export interface CommitOrchestratorDeps {
  chatRepo: ChatRepository;
  termsRepo: TermsRepository;
  notesRepo: NotesRepository;
  claude: AiClient;
  /**
   * askedByUser=true の語を承認画面を経由せず自動保存するために使う（2026-07-29追加）。
   * どちらも省略した場合は自動保存を行わず、これまでどおり全件を onProposalReady 経由の
   * 承認画面に回す（テスト等、自動保存を検証しない呼び出し元との後方互換のため任意項目にしてある）。
   */
  asksRepo?: AsksRepository;
  deviceId?: string | null;
  /** 分配案（askedByUser=falseの残りだけ）が用意できたら呼ばれる。ここではDBに一切書き込まない */
  onProposalReady: (proposal: DistributionProposal) => void;
  /** AI呼び出し失敗時。状態遷移図どおりセッションは open のまま残り、次回再試行される */
  onError?: (sessionId: string, error: unknown) => void;
  timeoutMs?: number;
  now?: () => number;
}

export interface CommitOrchestrator {
  /** トリガー①③（別用語のチャットを開いた／明示的な確定操作）。 即座に確定処理へ回す */
  triggerCommit(sessionId: string): Promise<void>;
  /** メッセージ送受信のたびに呼ぶ（open→openの遷移）。15分無操作でトリガー②が発火するようタイマーを引き直す */
  noteActivity(sessionId: string): void;
  /** トリガー④。起動時に1回呼ぶ。lastActiveAtが15分以上前のopenセッションをまとめて確定処理へ回す */
  recoverStaleSessions(): Promise<void>;
  /** アプリ終了時にタイマーを片付ける */
  dispose(): void;
}

/**
 * docs/architecture.md §5 の状態遷移図（open → committing → approving → committed）のうち
 * open→committing→approving の部分を実装する。承認・DB書き込み（applyDistribution）は
 * このオーケストレーターの外（承認画面UI、未実装）が担う——「分配は必ず承認画面を挟む」
 * （要件定義書§5.3）を構造として守るため、ここでは絶対にDBへ書き込まない。
 *
 * 「処理は冪等」（状態遷移図の注記）は proposeDistribution 自体が読み取り専用なので
 * 自然に満たされる。同じセッションを2回confirmしても、2回とも同じ提案が生成されるだけで
 * 実害が無い（実際の書き込みは承認後の applyDistribution 呼び出し1回だけ）。
 */
export function createCommitOrchestrator(deps: CommitOrchestratorDeps): CommitOrchestrator {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = deps.now ?? (() => Date.now());
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function clearTimer(sessionId: string): void {
    const timer = timers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(sessionId);
    }
  }

  async function commit(sessionId: string): Promise<void> {
    clearTimer(sessionId);
    try {
      // 「AIに聞く」ボタンを押した時点でセッションはDBに作成される（＝チャット画面が
      // 開かれる前提で先にIDが要る）。そのため、画面を開いただけで一言も送らずに
      // 離脱したセッションが open のまま残り得る。中身が無いのにAIへ確定処理を投げると、
      // 文脈ゼロの指示に対してAIが何かを捏造して返し、利用者の操作なしに承認画面へ
      // 遷移してしまう（実際に報告された不具合）。送信済みメッセージが1件も無い
      // セッションは、確定する内容が無いとみなしてAI呼び出し自体をスキップする。
      const messages = await deps.chatRepo.getMessages(sessionId);
      if (messages.length === 0) {
        await deps.chatRepo.commitSession(sessionId);
        return;
      }

      const proposal = await proposeDistribution(sessionId, {
        chatRepo: deps.chatRepo,
        termsRepo: deps.termsRepo,
        notesRepo: deps.notesRepo,
        claude: deps.claude,
      });

      if (deps.asksRepo && deps.deviceId) {
        const { autoApplied, remaining } = await autoApplyAskedTerms(proposal, {
          termsRepo: deps.termsRepo,
          notesRepo: deps.notesRepo,
          asksRepo: deps.asksRepo,
          deviceId: deps.deviceId,
        });
        // 元の提案が空だった場合（IT用語が1つも無い会話）は従来どおり空の提案を
        // 承認画面へ回す。自動保存によって「残りが0件になった」場合だけ、
        // 承認画面を出さずにそのままセッションを確定する。
        if (autoApplied.length > 0 && remaining.length === 0) {
          await deps.chatRepo.commitSession(sessionId);
          return;
        }
        deps.onProposalReady({ sessionId, proposedTerms: remaining });
        return;
      }

      deps.onProposalReady(proposal);
    } catch (error) {
      // committing --> open（API呼び出し失敗）。セッションは元々 open のままなので状態変更は不要
      deps.onError?.(sessionId, error);
    }
  }

  return {
    async triggerCommit(sessionId) {
      await commit(sessionId);
    },

    noteActivity(sessionId) {
      clearTimer(sessionId);
      const timer = setTimeout(() => {
        void commit(sessionId);
      }, timeoutMs);
      timers.set(sessionId, timer);
    },

    async recoverStaleSessions() {
      const stale = await deps.chatRepo.findStaleOpenSessions(now(), timeoutMs);
      for (const session of stale) {
        await commit(session.id);
      }
    },

    dispose() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
