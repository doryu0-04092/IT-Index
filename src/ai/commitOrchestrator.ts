import type { AsksRepository } from '../repositories/asks';
import type { ChatRepository } from '../repositories/chat';
import type { NotesRepository } from '../repositories/notes';
import type { TermsRepository } from '../repositories/terms';
import type { AiClient } from './aiClient';
import { commitProposal, proposeDistribution, type AutoUpdateExistingTermsMode } from './distribution';

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
}

export interface CommitOrchestrator {
  /** 明示的な確定操作（確定ボタン）。即座に確定処理へ回す */
  triggerCommit(sessionId: string): Promise<void>;
}

/**
 * docs/architecture.md §5 の状態遷移図（open → committing → committed）を実装する。
 *
 * 2026-07-30改訂: 承認画面（approving 状態）を廃止した。分配案は必ず commitProposal() で
 * 自動反映され、DBへの書き込みとセッションの commitSession() までこのオーケストレーターの
 * 責務になる（旧: 承認画面UIが担っていた）。何を自動反映するかは commitProposal() 内の
 * ルールと `autoUpdateExistingTerms` 設定で決まる（要件定義書§5.3）。
 *
 * 2026-07-30改訂（ローカルデータ層導入）: 自動トリガー（別用語のチャットを開いた／15分放置／
 * 起動時の放置セッション回収）を廃止し、確定操作は明示的なボタン実行（triggerCommit）のみにした
 * （docs/local-data.md）。理由は2つ: (1) Claude Code によるファイル編集を確定処理の起点である
 * 「取り込み → 適用 → 書き出し」の直前に必ず読む設計にしたため、確定タイミングを利用者が
 * 制御できることが前提になった、(2) 自動確定はファイル書き出しのタイミングを予測不能にし、
 * Claude Code の編集と衝突する窓を広げる。確定していないセッションはホームの
 * 「AIによる単語更新待ち」一覧（ChatRepository.getOpenSessions()）に残り、そこから確定する。
 *
 * 「処理は冪等」（状態遷移図の注記）は proposeDistribution 自体が読み取り専用、
 * commitSession() 自体も冪等なので保たれる。
 */
export function createCommitOrchestrator(deps: CommitOrchestratorDeps): CommitOrchestrator {
  async function commit(sessionId: string): Promise<void> {
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
  };
}
