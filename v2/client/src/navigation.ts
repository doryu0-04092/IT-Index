/**
 * 画面遷移の型。App.tsxへの責務集中を繰り返さないため(docs/v2/architecture.md §8)、
 * 遷移の型定義・戻り先の判定はここに分離する。v1と異なりルーターは追加せず、
 * state一本(useState<Screen>)で遷移する(要件定義書§4.1「単一レスポンシブUI」)。
 */

/**
 * 「履歴」タブのサブタブ。時系列を既定・最低限の機能とし、重み付けは個人的に作った
 * 特殊な機能の1つとして2番目に置く(本人指定)。「取り込み履歴」(v1のcommitsタブ相当。
 * ただし表示対象はdeclined(登録しない選択済み)セッションのみ)は3番目に追加する。
 * 連携履歴・競合選択は将来ここに追加できるよう型だけ拡張可能にしておく
 * (現時点では実装しない)。'sync' | 'conflicts' を将来追加する想定。
 */
export type HistoryView = 'timeline' | 'weighted' | 'commits';

export type Screen =
  | { name: 'search' }
  /**
   * 単語詳細画面。戻り先(returnTo)は開いた場所を丸ごと保持する(chatと同じ形。
   * 以前はDetailFrom+backScreenFor()で「戻り先の種類」だけを持っていたが、
   * 検索/索引/履歴のどのサブタブから開いても「元の画面に戻る」という同じ目的なので、
   * chatのreturnToと仕組みを1つに統一した)。
   */
  | { name: 'detail'; termId: string; returnTo: Screen }
  | { name: 'index' }
  | { name: 'history'; view: HistoryView }
  /**
   * 設定タブ(ライセンス・AI設定・接続先サーバー・表示・データ)。要件定義書§4「提供形態」。
   * 同期タブから移設したAI設定・表示(テーマ)をここに集約し、同期タブは同期機能に純化する。
   */
  | { name: 'settings' }
  | { name: 'sync' }
  /**
   * AIチャット画面。要件定義書§5.3。戻り先(returnTo)は開いた場所を丸ごと保持する
   * (単語詳細から開けば単語詳細へ、検索の「取り込み待ち」一覧から開けば検索へ戻る)。
   *
   * sessionIdは2つの形を取る(本人指定「最初の質問が実際に送信された時」までセッションを
   * 作らない遅延生成)。
   * - string: 既存のopenセッションを再開した場合。従来どおりの動作。
   * - null: 「下書き」。まだchatRepo.createSessionしていない。termId/subjectLabelで
   *   主題(誰について話すか)だけを渡し、ChatScreen側が最初の送信が成立する瞬間に
   *   createSessionする(screens/ChatScreen.tsx参照)。未ログイン等で一度も送信せずに
   *   戻った場合はセッション自体が生まれず、不可視の空セッションが残らない。
   */
  | {
      name: 'chat';
      sessionId: string;
      returnTo: Screen;
      /**
       * 画面を開いた直後に一度だけ自動送信する質問(検索欄の「AIで検索」で入力した文字列を
       * そのまま渡す。v1のinitialQuestion方式(../../src/App.tsx openDetail周辺)を移植)。
       * 新規(下書きから作られた)セッションのときだけ入る——既にやり取りがあるセッションの
       * 再開・リロード復元では同じ質問の二重送信になるため入れない(screenPersistence.tsで
       * 保存対象からも除く)。
       */
      initialQuestion?: string;
    }
  | {
      name: 'chat';
      sessionId: null;
      /** 下書きの主題。登録済みの語からなら辞書側のid、検索欄の「AIで検索」ならnull */
      termId: string | null;
      /** termId:nullのとき、利用者が入力した文字列そのもの。termId有りのときは未使用('') */
      subjectLabel: string;
      returnTo: Screen;
      initialQuestion?: string;
    };

export function screenKey(screen: Screen): string {
  if (screen.name === 'detail') return `detail:${screen.termId}`;
  if (screen.name === 'chat') {
    // 下書き(sessionId:null)が最初の送信でセッション化されても、このScreenオブジェクト自体は
    // 更新しない設計にしてある(App.tsx openChatForTerm/openChatForQuery参照)。もしsessionIdの
    // 有無だけで鍵を決めると、生成された瞬間に<main key={screenKey(screen)}>ごと再マウントされ、
    // 送信中の表示・入力途中の下書きが失われてしまう。そのため下書きの間は主題(termId/
    // subjectLabel)で鍵を固定し、送信成立をまたいでも鍵が変わらないようにする。
    return screen.sessionId !== null ? `chat:${screen.sessionId}` : `chat:draft:${screen.termId ?? screen.subjectLabel}`;
  }
  // historyはviewを含めない。サブタブ切替(timeline<->weighted)で<main key={screenKey}>を
  // 再マウントさせない=HistoryScreen内のデータ再取得を起こさないため(サブタブ切替は
  // 表示の並べ替えだけで、asks/termsの取得はタブ間で共通・不変)。
  return screen.name;
}
