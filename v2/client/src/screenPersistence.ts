import type { HistoryView, Screen } from './navigation';

/**
 * リロード時に直前の画面へ戻すための軽量な状態保存(v1 #39・../../src/screenPersistence.ts
 * を移植)。
 *
 * URLに状態を埋め込む本格的なルーティングではなく、sessionStorageに「どの画面にいたか」の
 * 最小限の識別子だけを保存する方式にした(v1と同じ考え方。本人確認済み)。そのため
 * ブックマーク・URL共有・タブ復元には対応しない——あくまで「同じタブでリロードした場合」専用。
 *
 * v2のScreen型はv1と異なりSubjectContext(AIへ渡す文脈)を持たない——ChatScreen/TermDetailScreen
 * 自身がsessionId/termIdからDBを引き直して表示する(v1はApp.tsx側でsubjectを再構築していたが、
 * v2は各画面が自分の主題解決を持つため不要)。そのためScreenはそのままJSONシリアライズ可能で、
 * v1のように「軽量な形に変換する」変換層はほぼ不要——ただしchatのinitialQuestionだけは
 * 保存対象から除く(#39と同じ理由。再送信の意味を持つ値を復元経路に持ち込まない)。
 */

const STORAGE_KEY = 'it-index-v2:last-screen';
const VALID_HISTORY_VIEWS: HistoryView[] = ['timeline', 'weighted'];
/** 壊れた/悪意あるJSON(循環参照風のネスト)で無限再帰しないための保険。通常のreturnToの
 * ネスト段数は数段程度にしかならないため、実用上十分大きい値にしておく。 */
const MAX_DEPTH = 20;

function isValidScreen(value: unknown, depth: number): value is Screen {
  if (depth > MAX_DEPTH) return false;
  if (typeof value !== 'object' || value === null || !('name' in value)) return false;
  const v = value as Record<string, unknown>;
  switch (v.name) {
    case 'search':
    case 'index':
    case 'sync':
    case 'settings':
      return true;
    case 'history':
      return typeof v.view === 'string' && VALID_HISTORY_VIEWS.includes(v.view as HistoryView);
    case 'detail':
      return typeof v.termId === 'string' && isValidScreen(v.returnTo, depth + 1);
    case 'chat':
      return typeof v.sessionId === 'string' && isValidScreen(v.returnTo, depth + 1);
    default:
      return false;
  }
}

/** sessionStorageから読んだJSONの検証。純関数なのでここだけユニットテスト対象にする */
export function isPersistedScreen(value: unknown): value is Screen {
  return isValidScreen(value, 0);
}

/** initialQuestion(chatのみ)を保存対象から取り除いた形にする */
function stripVolatile(screen: Screen): Screen {
  switch (screen.name) {
    case 'detail':
      return { name: 'detail', termId: screen.termId, returnTo: stripVolatile(screen.returnTo) };
    case 'chat':
      return { name: 'chat', sessionId: screen.sessionId, returnTo: stripVolatile(screen.returnTo) };
    default:
      return screen;
  }
}

export function persistScreen(screen: Screen): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stripVolatile(screen)));
  } catch {
    // sessionStorage不可(プライベートブラウジング等)でも致命的ではないため無視する
  }
}

/** 保存内容が壊れている・形が想定外の場合はnull(=検索画面のまま)を返す(v1の防御方針を踏襲) */
export function readPersistedScreen(): Screen | null {
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
