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

/**
 * 異常な `activatedAt`(過去に振り切れた値・壊れた保存値)で無限に近いループを回さないための上限。
 * 50年分あれば実用上足り、超えた場合は古い側が切れるだけで表示は壊れない。
 */
const MAX_HISTORY_MONTHS = 600;

/**
 * 課金開始日から `now` までに**到来済み**の請求日を、新しい順で返す(設定タブ「支払い履歴」用)。
 * 先頭の1件は課金開始日そのもの(初回の支払い)。
 *
 * `nextBillingDate` と同じ基準日・同じ月末繰り上げ規則で数える——「次回請求日」と
 * 「支払い履歴」が別々の数え方をすると、境界日にどちらか一方だけがずれて見えるため、
 * 日付の生成は `addMonthsClamped` の1箇所に集約している。
 *
 * **実際の課金は行っていないモック段階のため、ここで返るのは「請求が起きたことになっている日」**
 * であり、決済基盤の入金記録ではない(この但し書きは画面側にも出す)。
 */
export function listBilledDates(activatedAt: number, now: number): Date[] {
  const start = new Date(activatedAt);
  if (start.getTime() > now) return [];

  const dayOfMonth = start.getDate();
  const dates: Date[] = [start];
  for (let monthsAhead = 1; monthsAhead <= MAX_HISTORY_MONTHS; monthsAhead++) {
    const candidate = addMonthsClamped(start, dayOfMonth, monthsAhead);
    if (candidate.getTime() > now) break;
    dates.push(candidate);
  }
  return dates.reverse();
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
