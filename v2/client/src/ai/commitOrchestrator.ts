import type { ItIndexDB } from '../db';
import type { AsksRepository } from '../repositories/asks';
import type { ChatRepository } from '../repositories/chat';
import type { NotesRepository } from '../repositories/notes';
import type { TermsRepository } from '../repositories/terms';
import type { AiClient } from './aiClient';
import { commitProposal, proposeDistribution, type AutoUpdateExistingTermsMode } from './distribution';

export interface CommitOrchestratorDeps {
  /** terms/notes/asks/chatSessionsへの書き込みを1つのトランザクションに包むために使う */
  db: ItIndexDB;
  chatRepo: ChatRepository;
  termsRepo: TermsRepository;
  notesRepo: NotesRepository;
  asksRepo: AsksRepository;
  aiClient: AiClient;
  deviceId: string;
  /** 要件定義書§5.3「既存語の自動更新」。設定は持つがUIは無く、既定'askedOnly'で動作する */
  autoUpdateExistingTerms: AutoUpdateExistingTermsMode;
  /** AI呼び出し失敗時。状態遷移図どおりセッションはopenのまま残り、次回再試行される */
  onError?: (sessionId: string, error: unknown) => void;
  /**
   * 取り込み完了時(#167)。チャット経由・取り込み待ち一覧経由のどちらの確定でも
   * ここから1箇所で通知が飛ぶ——各画面はこれを起点に裏側でデータを差し替える
   * (再マウントせず、文字列の書き換え・行の追加のみで反映する。本人指定)。
   */
  onCommitted?: (sessionId: string) => void;
}

export interface CommitOrchestrator {
  /** 明示的な確定操作(確定ボタン)。即座に確定処理へ回す */
  triggerCommit(sessionId: string): Promise<void>;
}

/**
 * v1(../../../src/ai/commitOrchestrator.ts)から仕様を変えずに移植する
 * (open → committing → committed の3状態。承認画面・自動トリガーは既に廃止済みのため
 * 移植不要)。DB書き込みは1つのDexieトランザクションに包み、複数語を含む確定処理の
 * 途中で失敗した場合に部分的な書き込みが残らないようにする(v1 2026-08-06の修正と同じ理由)。
 */
export function createCommitOrchestrator(deps: CommitOrchestratorDeps): CommitOrchestrator {
  async function commit(sessionId: string): Promise<void> {
    // 取り込み中であることを先にDBへ記録する('open' → 'committing')。取れなかった＝
    // 既に別経路が処理中／取り込み済みなので何もしない。
    const started = await deps.chatRepo.beginCommit(sessionId);
    if (!started) return;

    try {
      // 送信済みメッセージが1件も無いセッションは、確定する内容が無いとみなしてAI呼び出し
      // 自体をスキップする(v1で実際に報告された不具合: 文脈ゼロの指示にAIが何かを捏造する)。
      const messages = await deps.chatRepo.getMessages(sessionId);
      if (messages.length === 0) {
        await deps.chatRepo.commitSession(sessionId);
        // 語の追加は無いが、セッションの状態(取り込み待ち一覧・取り込み履歴)は変わるため通知する
        deps.onCommitted?.(sessionId);
        return;
      }

      // AI呼び出し(時間がかかる・DBと無関係)はトランザクションの外で行う。
      const proposal = await proposeDistribution(sessionId, {
        chatRepo: deps.chatRepo,
        termsRepo: deps.termsRepo,
        notesRepo: deps.notesRepo,
        aiClient: deps.aiClient,
      });

      // 実際のDB書き込みは1つのトランザクションに包む(全部書き込まれるか、何も
      // 書き込まれないかのどちらかにする)。
      await deps.db.transaction('rw', [deps.db.terms, deps.db.notes, deps.db.asks, deps.db.chatSessions], async () => {
        await commitProposal(proposal, deps.autoUpdateExistingTerms, {
          termsRepo: deps.termsRepo,
          notesRepo: deps.notesRepo,
          asksRepo: deps.asksRepo,
          chatRepo: deps.chatRepo,
          deviceId: deps.deviceId,
        });
      });
      // トランザクション成功後にのみ通知する(部分的な書き込みは残らないため、
      // 通知が飛んだ時点で読み直せば必ず完全な結果が見える)
      deps.onCommitted?.(sessionId);
    } catch (error) {
      // committing --> open(API呼び出し失敗)。取り込み待ち一覧に戻し、再試行できるようにする。
      await deps.chatRepo.abortCommit(sessionId);
      deps.onError?.(sessionId, error);
    }
  }

  return {
    async triggerCommit(sessionId) {
      await commit(sessionId);
    },
  };
}
