/**
 * 検索結果をキーボードで選ぶ時の「次の選択位置」を決める
 * (v1 ../../../src/ui/shared/activeIndex.ts。境界の折り返しをテストしやすいよう
 * Reactに依存しない純関数として切り出す方針も踏襲する)。
 */

/** 未選択を表す位置。 */
export const NO_ACTIVE_INDEX = -1;

/**
 * @param current 現在の選択位置(未選択は-1)
 * @param direction 'down'なら次、'up'なら前
 * @param length 検索結果の件数
 * @returns 新しい選択位置。件数が0なら常に-1
 */
export function nextActiveIndex(current: number, direction: 'down' | 'up', length: number): number {
  if (length <= 0) return NO_ACTIVE_INDEX;
  if (direction === 'down') {
    return (current + 1) % length;
  }
  return current <= 0 ? length - 1 : current - 1;
}
