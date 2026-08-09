/**
 * 検索結果をキーボードで選ぶ時の「次の選択位置」を決める（2026-08-09追加）。
 *
 * 画面側から切り出した理由は2つ。
 * - 端の折り返し（最後で↓なら先頭へ、先頭で↑なら末尾へ）は境界の間違いが起きやすく、
 *   目視では確かめにくい
 * - このリポジトリの単体テストは純粋な関数に対して書く流儀のため、
 *   React に依存しない形にしておくと検証できる
 */

/** 未選択を表す位置。 */
export const NO_ACTIVE_INDEX = -1;

/**
 * @param current 現在の選択位置（未選択は -1）
 * @param direction 'down' なら次、'up' なら前
 * @param length 検索結果の件数
 * @returns 新しい選択位置。件数が0なら常に -1
 */
export function nextActiveIndex(current: number, direction: 'down' | 'up', length: number): number {
  if (length <= 0) return NO_ACTIVE_INDEX;
  if (direction === 'down') {
    // 未選択(-1)からの↓は先頭を選ぶ。末尾からは先頭へ折り返す
    return (current + 1) % length;
  }
  // 未選択(-1)からの↑は末尾を選ぶ。先頭からも末尾へ折り返す
  return current <= 0 ? length - 1 : current - 1;
}
