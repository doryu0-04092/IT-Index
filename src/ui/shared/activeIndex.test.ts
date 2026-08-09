import { describe, expect, it } from 'vitest';
import { NO_ACTIVE_INDEX, nextActiveIndex } from './activeIndex';

describe('nextActiveIndex', () => {
  it('未選択から下キーで先頭を選ぶ', () => {
    expect(nextActiveIndex(NO_ACTIVE_INDEX, 'down', 3)).toBe(0);
  });

  it('未選択から上キーで末尾を選ぶ', () => {
    expect(nextActiveIndex(NO_ACTIVE_INDEX, 'up', 3)).toBe(2);
  });

  it('下キーで1つ進む', () => {
    expect(nextActiveIndex(0, 'down', 3)).toBe(1);
  });

  it('上キーで1つ戻る', () => {
    expect(nextActiveIndex(2, 'up', 3)).toBe(1);
  });

  it('末尾で下キーを押すと先頭へ折り返す', () => {
    expect(nextActiveIndex(2, 'down', 3)).toBe(0);
  });

  it('先頭で上キーを押すと末尾へ折り返す', () => {
    expect(nextActiveIndex(0, 'up', 3)).toBe(2);
  });

  it('結果が1件なら移動しても同じ位置に留まる', () => {
    expect(nextActiveIndex(0, 'down', 1)).toBe(0);
    expect(nextActiveIndex(0, 'up', 1)).toBe(0);
  });

  it('結果が0件なら常に未選択', () => {
    expect(nextActiveIndex(NO_ACTIVE_INDEX, 'down', 0)).toBe(NO_ACTIVE_INDEX);
    expect(nextActiveIndex(0, 'up', 0)).toBe(NO_ACTIVE_INDEX);
  });
});
