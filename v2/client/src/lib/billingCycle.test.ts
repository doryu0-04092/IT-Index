import { describe, expect, it } from 'vitest';
import { formatBillingDate, nextBillingDate } from './billingCycle';

/** ローカル時刻で作る(nextBillingDateはDateのローカル日付で数える) */
function at(year: number, month1to12: number, day: number, hour = 0): number {
  return new Date(year, month1to12 - 1, day, hour).getTime();
}

describe('nextBillingDate', () => {
  it('課金開始日の翌月同日を返す', () => {
    const start = at(2026, 8, 18);
    expect(formatBillingDate(nextBillingDate(start, at(2026, 8, 20)))).toBe('2026年9月18日');
  });

  it('請求日を過ぎたら次の月へ進む(複数月の経過にも追従する)', () => {
    const start = at(2026, 8, 18);
    expect(formatBillingDate(nextBillingDate(start, at(2026, 9, 19)))).toBe('2026年10月18日');
    expect(formatBillingDate(nextBillingDate(start, at(2026, 12, 25)))).toBe('2027年1月18日');
  });

  it('請求日当日は、その日を過ぎるまで当日を返し続ける', () => {
    const start = at(2026, 8, 18, 12);
    // 同日でも開始時刻(12時)より前なら当月の請求日が「次回」
    expect(formatBillingDate(nextBillingDate(start, at(2026, 9, 18, 9)))).toBe('2026年9月18日');
    // 過ぎたら翌月
    expect(formatBillingDate(nextBillingDate(start, at(2026, 9, 18, 13)))).toBe('2026年10月18日');
  });

  it('月末開始は、その月に無い日を末日へ繰り上げる', () => {
    const start = at(2026, 1, 31);
    // 2026年2月は28日まで
    expect(formatBillingDate(nextBillingDate(start, at(2026, 2, 1)))).toBe('2026年2月28日');
    // 繰り上げても基準日は31日のまま。3月は31日に戻る
    expect(formatBillingDate(nextBillingDate(start, at(2026, 3, 1)))).toBe('2026年3月31日');
    // 4月は30日まで
    expect(formatBillingDate(nextBillingDate(start, at(2026, 4, 1)))).toBe('2026年4月30日');
  });

  it('うるう年の2月29日も扱える', () => {
    const start = at(2028, 1, 31);
    expect(formatBillingDate(nextBillingDate(start, at(2028, 2, 1)))).toBe('2028年2月29日');
  });

  it('年をまたぐ', () => {
    const start = at(2026, 12, 5);
    expect(formatBillingDate(nextBillingDate(start, at(2026, 12, 10)))).toBe('2027年1月5日');
  });
});
