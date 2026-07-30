import { useEffect, useState } from 'react';
import { ensureFolderPermission, isFolderSyncAvailable } from '../../manualSync/folderTransport';
import {
  resetToInitialData,
  runLocalImportIfChanged,
  setupLocalFolder,
  type LocalFolderDeps,
} from '../../localData/localFolderSync';
import type { SyncFolderRepository } from '../../repositories/syncFolder';

export interface LocalFolderPanelProps {
  folder: FileSystemDirectoryHandle | null;
  onFolderChange: (dir: FileSystemDirectoryHandle | null) => void;
  syncFolderRepo: SyncFolderRepository;
  /** deviceId 読み込み前は null。null の間はボタンを無効化する */
  deps: LocalFolderDeps | null;
}

/**
 * 設定画面の「ローカルデータ」セクション。docs/local-data.md の実装。
 * フォルダ選択・権限状態の表示・手動読み込み・初期化を担う。取り込み・書き出し自体の実処理は
 * src/localData/localFolderSync.ts に委ね、ここはUIの状態管理のみを持つ。
 */
export default function LocalFolderPanel({ folder, onFolderChange, syncFolderRepo, deps }: LocalFolderPanelProps) {
  const [permission, setPermission] = useState<'granted' | 'prompt' | 'denied' | 'unknown'>('unknown');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!folder) {
      setPermission('unknown');
      return;
    }
    folder.queryPermission({ mode: 'readwrite' }).then(setPermission);
  }, [folder]);

  if (!isFolderSyncAvailable()) {
    return (
      <section className="settings-section">
        <h3>ローカルデータ</h3>
        <p className="search-status">この環境では使えません（PC版 Chrome/Edge のみ対応）。</p>
      </section>
    );
  }

  async function handlePickFolder() {
    if (!deps) return;
    setBusy(true);
    setStatus(null);
    try {
      const { dir, importOutcome } = await setupLocalFolder(syncFolderRepo, deps);
      onFolderChange(dir);
      setPermission('granted');
      setStatus(summarizeOutcome(importOutcome.result));
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return; // ダイアログを閉じただけ
      setStatus(`フォルダの選択に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleReadNow() {
    if (!folder || !deps) return;
    setBusy(true);
    setStatus(null);
    try {
      const granted = await ensureFolderPermission(folder);
      setPermission(granted ? 'granted' : 'denied');
      if (!granted) {
        setStatus('権限が許可されませんでした。');
        return;
      }
      const outcome = await runLocalImportIfChanged(folder, deps);
      setStatus(outcome.ran ? summarizeOutcome(outcome.result) : '変更はありませんでした。');
    } catch (err) {
      setStatus(`読み込みに失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleForget() {
    await syncFolderRepo.clear();
    onFolderChange(null);
    setStatus(null);
  }

  async function handleReset() {
    if (!folder || !deps) return;
    const confirmed = window.confirm(
      '追加・変更した語をすべて初期状態に戻します（元から入っている語には影響しません）。バックアップは backups/ に残ります。よろしいですか？',
    );
    if (!confirmed) return;

    setBusy(true);
    setStatus(null);
    try {
      const granted = await ensureFolderPermission(folder);
      if (!granted) {
        setStatus('権限が許可されなかったため中止しました。');
        return;
      }
      await resetToInitialData(folder, deps);
      setStatus('初期データに戻しました。');
    } catch (err) {
      setStatus(`初期化に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section">
      <h3>ローカルデータ</h3>
      <p className="search-status">
        Claude Code などのAIエージェントが編集できるフォルダを指定できます。フォルダ内の
        <code>data/terms.json</code>・<code>data/notes/*.md</code> を編集すると、アプリの再読み込み時に反映されます。
      </p>

      {!folder ? (
        <button type="button" onClick={handlePickFolder} disabled={busy || !deps}>
          フォルダを選択
        </button>
      ) : (
        <>
          <p className="search-status">
            権限: {permission === 'granted' ? '許可済み' : permission === 'denied' ? '拒否されています' : '未確認/期限切れ'}
          </p>
          {permission !== 'granted' && (
            <p className="search-status">
              選択ダイアログで「毎回許可」を選ぶと、次回以降は無操作で読み込まれます。
            </p>
          )}
          <div className="api-key-actions">
            <button type="button" onClick={handleReadNow} disabled={busy || !deps}>
              今すぐ読み込む
            </button>
            <button type="button" onClick={handlePickFolder} disabled={busy || !deps}>
              フォルダを変更
            </button>
            <button type="button" onClick={handleForget} disabled={busy}>
              連携を解除
            </button>
          </div>
          <button type="button" onClick={handleReset} disabled={busy || !deps}>
            初期データに戻す
          </button>
        </>
      )}

      {status && <p className="search-status">{status}</p>}
    </section>
  );
}

function summarizeOutcome(result: Awaited<ReturnType<typeof runLocalImportIfChanged>>['result']): string {
  if (!result) return '変更はありませんでした。';
  if (!result.ok) return `取り込みを中止しました: ${result.reason}`;
  const parts = [`追加${result.addedTerms}語`, `更新${result.updatedTerms}語`];
  if (result.tombstonedTerms > 0) parts.push(`削除${result.tombstonedTerms}語`);
  if (result.appliedNotes > 0) parts.push(`ノート${result.appliedNotes}件`);
  if (result.skippedNotes.length > 0) parts.push(`未反映のノート${result.skippedNotes.length}件`);
  return `取り込みました（${parts.join('、')}）`;
}
