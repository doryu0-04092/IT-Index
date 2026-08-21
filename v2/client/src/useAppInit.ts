import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AutoUpdateExistingTermsMode } from './ai/distribution';
import { db } from './db';
import { createAsksRepository, type AsksRepository } from './repositories/asks';
import { createChatRepository, type ChatRepository } from './repositories/chat';
import { createNoteConflictsRepository, type NoteConflictsRepository } from './repositories/noteConflicts';
import { createNotesRepository, type NotesRepository } from './repositories/notes';
import { createSettingsRepository, type SettingsRepository } from './repositories/settings';
import { createSyncEventsRepository, type SyncEventsRepository } from './repositories/syncEvents';
import { createSyncStateRepository, type SyncStateRepository } from './repositories/syncState';
import { createTermsRepository, type TermsRepository } from './repositories/terms';
import { detectIsNativeApp } from './lib/platform';
import { fetchSeedFile, importSeed } from './seed/importSeed';
import { resetSyncCursorOnce } from './sync/cursorMigration';

export interface AppInit {
  termsRepo: TermsRepository;
  notesRepo: NotesRepository;
  asksRepo: AsksRepository;
  chatRepo: ChatRepository;
  settingsRepo: SettingsRepository;
  noteConflictsRepo: NoteConflictsRepository;
  syncEventsRepo: SyncEventsRepository;
  syncStateRepo: SyncStateRepository;
  /** settingsRepo.get()が終わるまでnull(初回起動時にcrypto.randomUUID()で発行される) */
  deviceId: string | null;
  /**
   * Androidネイティブ(Capacitorアプリ)ならtrue(#157)。判定が終わるまでfalse
   * (誤ってfalse側で描画されても「解消操作が一瞬見える」だけで、判定は起動直後に確定する。
   * PCブラウザ・スマートフォンのブラウザはどちらもfalse=解消できる側)。
   */
  isNativeApp: boolean;
  /**
   * `isNativeApp` の判定が**終わっているか**(#217)。
   *
   * `isNativeApp` の初期値 `false` は「PCである」ではなく「まだ分からない」を意味する。
   * 見た目の出し分けなら未確定のまま描画してもすぐ直るが、**同期に渡す
   * `holdLocalOnConflict` は取り返しがつかない**——Androidで `false` のまま走ると
   * newest-wins マージになり、ローカルのノートが履歴に残らないまま上書きされる(#157参照)。
   * 起動時の自動pull(App.tsx)はこれが true になるまで待つ。
   *
   * `detectIsNativeApp()` は読み込みに失敗しても `false` を返して**必ず解決する**
   * (lib/platform.ts)ため、これが永久に false のままになることは無い。
   */
  platformSettled: boolean;
  /**
   * 既存語への自動反映の範囲(要件定義書§5.3)。設定UIは無く、settingsRepo.get()の既定値
   * ('askedOnly')で動作する。settingsRepo.get()が終わるまでは'askedOnly'を仮の値として使う
   * (この間に確定操作自体が起きることは無い。deviceIdもnullで確定オーケストレーターが
   * 使えないため)。
   */
  autoUpdateExistingTerms: AutoUpdateExistingTermsMode;
  /** シード取り込みに失敗した場合のみ非null。既取り込み済みの場合はnullのまま */
  seedError: string | null;
  /** シード取り込み(初回・再試行)が完了しているか。falseの間は画面を出さない */
  seedSettled: boolean;
  /** シード取り込みが完了するたびに増分。SearchScreen側のterms再読み込みトリガー */
  seedRefreshTick: number;
  /** シード取り込みを再試行する(SearchScreenの「再試行」ボタンから呼ぶ) */
  runSeedImport: () => Promise<void>;
}

/**
 * DB初期化・シード取り込み・deviceId発行をApp.tsxから分離する(docs/v2/architecture.md §8
 * 「App.tsxへの責務集中は再現しない」)。画面遷移・確定オーケストレーションはApp.tsx側で持つ。
 */
export function useAppInit(): AppInit {
  const termsRepo = useMemo(() => createTermsRepository(db), []);
  const notesRepo = useMemo(() => createNotesRepository(db), []);
  const asksRepo = useMemo(() => createAsksRepository(db), []);
  const chatRepo = useMemo(() => createChatRepository(db), []);
  const settingsRepo = useMemo(() => createSettingsRepository(db), []);
  const noteConflictsRepo = useMemo(() => createNoteConflictsRepository(db), []);
  const syncEventsRepo = useMemo(() => createSyncEventsRepository(db), []);
  const syncStateRepo = useMemo(() => createSyncStateRepository(db), []);

  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [isNativeApp, setIsNativeApp] = useState(false);
  const [platformSettled, setPlatformSettled] = useState(false);
  const [autoUpdateExistingTerms, setAutoUpdateExistingTerms] = useState<AutoUpdateExistingTermsMode>('askedOnly');
  const [seedError, setSeedError] = useState<string | null>(null);
  const [seedSettled, setSeedSettled] = useState(false);
  const [seedRefreshTick, setSeedRefreshTick] = useState(0);

  const runSeedImport = useCallback(async () => {
    // awaitを最初に置き、setSeedError(null)を呼び出し元(useEffect)の同期実行から切り離す
    // (react-hooks/set-state-in-effectが「effect内での同期的なsetState呼び出し」を検出するため。
    // 「取り込み中…」の表示切り替え自体はこの1マイクロタスク分の遅延では変わらない)。
    await Promise.resolve();
    setSeedError(null);
    try {
      const result = await importSeed(fetchSeedFile, termsRepo, settingsRepo);
      if (!result.imported && result.reason !== 'already up to date') {
        setSeedError(`取り込みを中止しました: ${result.reason}`);
      }
    } catch (err) {
      setSeedError(`取り込みに失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSeedSettled(true);
      setSeedRefreshTick((t) => t + 1);
    }
  }, [termsRepo, settingsRepo]);

  useEffect(() => {
    // マウント時のシード取り込み・deviceId読み込みは、ユーザー操作に紐づくイベントハンドラが
    // 存在しない起動時副作用であり、effectで行うのが正しい(react-hooks/set-state-in-effectの
    // 想定するアンチパターン「イベントに応じた状態更新をeffectで行う」には当たらない)。
    // runSeedImportは最初のawait後にしかsetStateを呼ばない(useAppInit内、Promise.resolve()で
    // 明示的に切り離し済み)が、このルールは間接呼び出しの先まで静的に検出するため、
    // このマウント時fetchパターンに限り無効化する。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void runSeedImport();
    void settingsRepo.get().then((s) => {
      setDeviceId(s.deviceId);
      setAutoUpdateExistingTerms(s.autoUpdateExistingTerms);
    });
    // プラットフォーム判定(#157)。競合解消UIの出し分け(PC=解消可/Androidネイティブ=案内のみ)に使う。
    // 判定の完了(platformSettled)も併せて立てる——起動時の自動pullが待つため(#217)
    void detectIsNativeApp().then((native) => {
      setIsNativeApp(native);
      setPlatformSettled(true);
    });
    // 起動時クリーンアップ(本人指定)。旧バージョンの残骸——不可視の空セッションと、
    // AI呼び出し失敗で質問だけが残ったセッション(#132以前の保存順によるもの)——を
    // 一度だけ削除する。setStateを呼ばないためeffect内から直接fire-and-forgetしてよい
    // (結果を画面表示に反映する必要が無い)。
    void chatRepo.deleteUnansweredOpenSessions();
    // 同期カーソルの一度きりのリセット(#191)。#182以前のコードは暗号化された差分を
    // 読み飛ばした上でカーソルを進めていたため、更新後もその分を永久に取りこぼす。
    // 起動時に一度だけ0へ戻し、次の同期で読み直させる(マージは冪等なので再取り込みは無害)。
    // 同期の実行前に済ませる必要があるが、同期は利用者の操作が起点のため起動時に走らせれば足りる。
    void resetSyncCursorOnce(syncStateRepo);
  }, [runSeedImport, settingsRepo, chatRepo, syncStateRepo]);

  return {
    termsRepo,
    notesRepo,
    asksRepo,
    chatRepo,
    settingsRepo,
    noteConflictsRepo,
    syncEventsRepo,
    syncStateRepo,
    deviceId,
    isNativeApp,
    platformSettled,
    autoUpdateExistingTerms,
    seedError,
    seedSettled,
    seedRefreshTick,
    runSeedImport,
  };
}
