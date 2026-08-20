import { describe, expect, it } from 'vitest';
import { formatBillingDate, listBilledDates, nextBillingDate } from './billingCycle';

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

describe('listBilledDates', () => {
  const formatted = (activatedAt: number, now: number) =>
    listBilledDates(activatedAt, now).map(formatBillingDate);

  it('購入直後は初回の1件だけを返す(課金開始日そのもの)', () => {
    const start = at(2026, 8, 18, 12);
    expect(formatted(start, at(2026, 8, 20))).toEqual(['2026年8月18日']);
  });

  it('到来済みの請求日を新しい順で返す', () => {
    const start = at(2026, 5, 18, 12);
    expect(formatted(start, at(2026, 8, 20))).toEqual([
      '2026年8月18日',
      '2026年7月18日',
      '2026年6月18日',
      '2026年5月18日',
    ]);
  });

  it('未到来の請求日は含めない(nextBillingDateとの境界が一致する)', () => {
    const start = at(2026, 8, 18, 12);
    // 9/18の開始時刻(12時)より前は、まだ2回目が到来していない
    expect(formatted(start, at(2026, 9, 18, 9))).toEqual(['2026年8月18日']);
    expect(formatBillingDate(nextBillingDate(start, at(2026, 9, 18, 9)))).toBe('2026年9月18日');
    // 過ぎた直後に履歴へ入り、次回請求日が翌月へ動く
    expect(formatted(start, at(2026, 9, 18, 13))).toEqual(['2026年9月18日', '2026年8月18日']);
    expect(formatBillingDate(nextBillingDate(start, at(2026, 9, 18, 13)))).toBe('2026年10月18日');
  });

  it('月末開始は、nextBillingDateと同じ繰り上げ規則で数える', () => {
    const start = at(2026, 1, 31);
    expect(formatted(start, at(2026, 4, 30, 23))).toEqual([
      '2026年4月30日',
      '2026年3月31日',
      '2026年2月28日',
      '2026年1月31日',
    ]);
  });

  it('年をまたいで数え続ける', () => {
    const start = at(2026, 12, 5);
    expect(formatted(start, at(2027, 2, 6))).toEqual([
      '2027年2月5日',
      '2027年1月5日',
      '2026年12月5日',
    ]);
  });

  it('課金開始日が未来なら空を返す(表示するものが無い)', () => {
    const start = at(2026, 9, 1);
    expect(listBilledDates(start, at(2026, 8, 20))).toEqual([]);
  });
});
