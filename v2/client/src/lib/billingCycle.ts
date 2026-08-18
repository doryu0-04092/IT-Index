/**
 * 月額サブスクの請求日の算出(設定タブ「ライセンス」欄の課金開始日・次回請求日の表示用)。
 * lib/cardValidation.tsと同じく、DOM・React非依存の純関数だけを置き単体テストから直接呼ぶ。
 *
 * 「実際の課金は行わない」モック段階のため、ここでの請求日は**課金開始日から月単位で
 * 繰り返す予定日**を表すだけで、決済基盤の請求サイクルとは結びついていない。
 */

/**
 * 課金開始日の「日」を保ったまま、nowより後になる最初の請求日を返す。
 *
 * 月末日の扱い: 1/31開始なら2月は末日(2/28または2/29)に繰り上げる。Dateの月加算は
 * 31日→3/3のように溢れるため、加算後に月がずれていたら前月末へ引き戻す。
 * この繰り上げは翌月以降の基準日を変えない(常に開始日の「日」から数え直す)。
 */
export function nextBillingDate(activatedAt: number, now: number): Date {
  const start = new Date(activatedAt);
  const dayOfMonth = start.getDate();

  for (let monthsAhead = 1; ; monthsAhead++) {
    const candidate = addMonthsClamped(start, dayOfMonth, monthsAhead);
    if (candidate.getTime() > now) return candidate;
  }
}

function addMonthsClamped(start: Date, dayOfMonth: number, monthsAhead: number): Date {
  const candidate = new Date(start);
  candidate.setDate(1); // 溢れを避けるため、月を進める前に安全な日へ寄せる
  candidate.setMonth(candidate.getMonth() + monthsAhead);
  const lastDayOfMonth = new Date(
    candidate.getFullYear(),
    candidate.getMonth() + 1,
    0
  ).getDate();
  candidate.setDate(Math.min(dayOfMonth, lastDayOfMonth));
  return candidate;
}

/** 画面表示用の日付("2026年9月18日")。ロケール差で表記が揺れないよう自前で組む */
export function formatBillingDate(date: Date): string {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}
