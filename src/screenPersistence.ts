import type { HistoryView } from './ui/pc/HistoryScreen';

/**
 * リロード時に直前の画面へ戻すための軽量な状態保存（#39）。
 *
 * URLに状態を埋め込む本格的なルーティングではなく、sessionStorageに「どの画面にいたか」
 * の最小限の識別子だけを保存する方式にした（本人確認済み）。そのためブックマーク・
 * URL共有・タブ復元には対応しない——あくまで「同じタブでリロードした場合」専用の対処。
 *
 * `chat`画面はSubjectContext（AIへ渡す文脈）を丸ごと保存するのではなく`sessionId`だけを
 * 保存し、復元時にApp.tsx側でChatRepository.getSession()→buildSubjectContext()を呼び直して
 * 再構築する（SubjectContextは用語の要約等を含み、保存時点のスナップショットが古くなり得るため）。
 */
/** 単語詳細画面の遷移元。App.tsxのDetailFromと同じ形（検索から来た場合は情報を持たない） */
type PersistedDetailFrom = 'search' | 'index' | { screen: 'history'; view: HistoryView };

export type PersistedScreen =
  | { name: 'search' }
  | { name: 'detail'; termId: string; from: PersistedDetailFrom }
  | { name: 'chat'; sessionId: string; returnTermId: string | null }
  | { name: 'history'; view: HistoryView }
  | { name: 'index' }
  | { name: 'settings' }
  | { name: 'link' };

const STORAGE_KEY = 'it-index-last-screen';
const VALID_HISTORY_VIEWS: HistoryView[] = ['weighted', 'timeline', 'sync', 'commits', 'conflicts'];

function isValidDetailFrom(value: unknown): value is PersistedDetailFrom {
  if (value === 'search' || value === 'index') return true;
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.screen === 'history' && typeof v.view === 'string' && VALID_HISTORY_VIEWS.includes(v.view as HistoryView);
}

/** sessionStorageから読んだJSONの検証。純関数なのでここだけユニットテスト対象にする */
export function isPersistedScreen(value: unknown): value is PersistedScreen {
  if (typeof value !== 'object' || value === null || !('name' in value)) return false;
  const v = value as Record<string, unknown>;
  switch (v.name) {
    case 'search':
      return true;
    case 'detail':
      return typeof v.termId === 'string' && isValidDetailFrom(v.from);
    case 'chat':
      return typeof v.sessionId === 'string' && (v.returnTermId === null || typeof v.returnTermId === 'string');
    case 'history':
      return typeof v.view === 'string' && VALID_HISTORY_VIEWS.includes(v.view as HistoryView);
    case 'index':
    case 'settings':
    case 'link':
      return true;
    default:
      return false;
  }
}

export function persistScreen(screen: PersistedScreen): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(screen));
  } catch {
    // sessionStorage不可（プライベートブラウジング等）でも致命的ではないため無視する
  }
}

export function readPersistedScreen(): PersistedScreen | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isPersistedScreen(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearPersistedScreen(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // 無視
  }
}
