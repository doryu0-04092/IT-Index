import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AutoUpdateExistingTermsMode } from './ai/distribution';
import { db } from './db';
import { createAsksRepository, type AsksRepository } from './repositories/asks';
import { createChatRepository, type ChatRepository } from './repositories/chat';
import { createNoteConflictsRepository, type NoteConflictsRepository } from './repositories/noteConflicts';
import { createNotesRepository, type NotesRepository } from './repositories/notes';
import { createSettingsRepository, type SettingsRepository } from './repositories/settings';
import { createSyncStateRepository, type SyncStateRepository } from './repositories/syncState';
import { createTermsRepository, type TermsRepository } from './repositories/terms';
import { fetchSeedFile, importSeed } from './seed/importSeed';

export interface AppInit {
  termsRepo: TermsRepository;
  notesRepo: NotesRepository;
  asksRepo: AsksRepository;
  chatRepo: ChatRepository;
  settingsRepo: SettingsRepository;
  noteConflictsRepo: NoteConflictsRepository;
  syncStateRepo: SyncStateRepository;
  /** settingsRepo.get()が終わるまでnull(初回起動時にcrypto.randomUUID()で発行される) */
  deviceId: string | null;
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
  const syncStateRepo = useMemo(() => createSyncStateRepository(db), []);

  const [deviceId, setDeviceId] = useState<string | null>(null);
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
  }, [runSeedImport, settingsRepo]);

  return {
    termsRepo,
    notesRepo,
    asksRepo,
    chatRepo,
    settingsRepo,
    noteConflictsRepo,
    syncStateRepo,
    deviceId,
    autoUpdateExistingTerms,
    seedError,
    seedSettled,
    seedRefreshTick,
    runSeedImport,
  };
}
