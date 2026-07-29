import type { AsksRepository } from '../repositories/asks';
import type { ChatRepository } from '../repositories/chat';
import type { NotesRepository } from '../repositories/notes';
import type { TermsRepository } from '../repositories/terms';
import type { AiClient } from './aiClient';
import { commitProposal, proposeDistribution, type AutoUpdateExistingTermsMode } from './distribution';

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export interface CommitOrchestratorDeps {
  chatRepo: ChatRepository;
  termsRepo: TermsRepository;
  notesRepo: NotesRepository;
  asksRepo: AsksRepository;
  claude: AiClient;
  deviceId: string;
  /** 要件定義書§5.3「既存語の自動更新」。設定画面で切り替える（既定 'askedOnly'） */
  autoUpdateExistingTerms: AutoUpdateExistingTermsMode;
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
 * docs/architecture.md §5 の状態遷移図（open → committing → committed）を実装する。
 *
 * 2026-07-30改訂: 承認画面（approving 状態）を廃止した。分配案は必ず commitProposal() で
 * 自動反映され、DBへの書き込みとセッションの commitSession() までこのオーケストレーターの
 * 責務になる（旧: 承認画面UIが担っていた）。何を自動反映するかは commitProposal() 内の
 * ルールと `autoUpdateExistingTerms` 設定で決まる（要件定義書§5.3）。
 *
 * 「処理は冪等」（状態遷移図の注記）は proposeDistribution 自体が読み取り専用、
 * commitSession() 自体も冪等なので保たれる。
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
      // 文脈ゼロの指示に対してAIが何かを捏造して返してしまう（実際に報告された不具合）。
      // 送信済みメッセージが1件も無いセッションは、確定する内容が無いとみなしてAI呼び出し自体をスキップする。
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

      await commitProposal(proposal, deps.autoUpdateExistingTerms, {
        termsRepo: deps.termsRepo,
        notesRepo: deps.notesRepo,
        asksRepo: deps.asksRepo,
        chatRepo: deps.chatRepo,
        deviceId: deps.deviceId,
      });
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
