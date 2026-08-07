import type { ItIndexDB } from '../db';
import type { AsksRepository } from '../repositories/asks';
import type { ChatRepository } from '../repositories/chat';
import type { NotesRepository } from '../repositories/notes';
import type { TermsRepository } from '../repositories/terms';
import type { AiClient } from './aiClient';
import { commitProposal, proposeDistribution, type AutoUpdateExistingTermsMode } from './distribution';

export interface CommitOrchestratorDeps {
  /** terms/notes/asks/chatSessionsへの書き込みを1つのトランザクションに包むために使う（下記参照） */
  db: ItIndexDB;
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
 * 2026-07-30改訂: 自動トリガー（別用語のチャットを開いた／15分放置／起動時の放置セッション回収）を
 * 廃止し、確定操作は明示的なボタン実行（triggerCommit）のみにした。
 *
 * 2026-08-04改訂: 取り込み操作をホーム画面（SearchScreen）の「まとめて単語帳に取り込む」1箇所に
 * 集約した。一度は起動時の自動確定を復活させたが、APIキーはセッション限りの保持なので起動直後は
 * 必ず未認証で、「確定処理に失敗しました: APIキーが設定されていません」が必ず出た（docs/ui-pc.md
 * §3 バグ6と同じ形の再発）うえ、「AIと会話した内容は自動では保存されない」という利用者への説明とも
 * 矛盾していたため、再び廃止した。確定していないセッションはホームの「取り込み待ち」一覧
 * （ChatRepository.getOpenSessions()）に残り、そこから取り込む。
 *
 * 「処理は冪等」（状態遷移図の注記）は proposeDistribution 自体が読み取り専用、
 * commitSession() 自体も冪等なので保たれる。
 *
 * 2026-08-06改訂: commitProposal()（terms/notes/asksへの書き込み＋セッションのcommitSession()）を
 * 1つのDexieトランザクションで包む。それまでは各テーブルへの書き込みが個別に確定していたため、
 * 複数語を含む確定処理の途中（例: 3語中2語目の書き込み）で失敗すると、1語目だけが書き込まれた
 * 半端な状態がDBに残ったままセッションだけ'open'に戻り、再試行すると同じ語がもう一度
 * 書き込まれる（askは新規UUIDで積み増しなので重複する）不具合があった（ユーザー指摘）。
 * トランザクション化により、失敗時は書き込みが全て自動的にロールバックされ、
 * 「何も書き込まれていない・セッションもopenのまま」という一貫した状態からやり直せる。
 * チャットメッセージ自体（chatMessages）はこの処理では一切書き込まない・削除しないため、
 * 確定の成否に関わらず常に残る。
 */
export function createCommitOrchestrator(deps: CommitOrchestratorDeps): CommitOrchestrator {
  async function commit(sessionId: string): Promise<void> {
    // 取り込み中であることを先にDBへ記録する（'open' → 'committing'）。取れなかった＝
    // 既に別経路が処理中／取り込み済みなので何もしない。これでAI呼び出しの数秒〜十数秒の間に
    // 同じセッションが再開・再取り込みされるのを防ぐ（types.ts の status 参照）。
    const started = await deps.chatRepo.beginCommit(sessionId);
    if (!started) return;

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

      // AI呼び出し（時間がかかる・DBと無関係）はトランザクションの外で行う。
      const proposal = await proposeDistribution(sessionId, {
        chatRepo: deps.chatRepo,
        termsRepo: deps.termsRepo,
        notesRepo: deps.notesRepo,
        claude: deps.claude,
      });

      // 実際のDB書き込みは1つのトランザクションに包む。複数語のうち一部だけ書き込まれた
      // 状態でエラーになることを防ぐ（全部書き込まれるか、何も書き込まれないかのどちらかにする）。
      await deps.db.transaction('rw', [deps.db.terms, deps.db.notes, deps.db.asks, deps.db.chatSessions], async () => {
        await commitProposal(proposal, deps.autoUpdateExistingTerms, {
          termsRepo: deps.termsRepo,
          notesRepo: deps.notesRepo,
          asksRepo: deps.asksRepo,
          chatRepo: deps.chatRepo,
          deviceId: deps.deviceId,
        });
      });
    } catch (error) {
      // committing --> open（API呼び出し失敗）。取り込み待ち一覧に戻し、再試行できるようにする。
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
