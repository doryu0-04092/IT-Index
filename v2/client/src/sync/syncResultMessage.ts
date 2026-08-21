import type { SyncRunResult } from './syncEngine';

/**
 * 同期結果の文言を組み立てる(#216)。
 *
 * **パネル(SyncScreenの結果表示)とトースト通知の両方がこの1関数を呼ぶ。**
 * 元は同じ `handleSyncNow` の中で2箇所が別々に文字列を組んでいたため、#202 で
 * 「受信N件」を「実際に変わった語数」へ改めた際にパネル側だけが直り、トーストには
 * 意味を持たない `受信N件` が残った——利用者から見ると、1回の同期で
 * 「変わった内容はありません」と「受信1件」が同時に出る状態になっていた。
 *
 * `receivedBlobs` を文言に出さないのは #202 の判断のとおり: 端末は毎回**全量スナップショット**を
 * 送るため、中身が同じでもblobは1件と数えられる。利用者が知りたいのは「何が変わったか」で、
 * blobの件数はその答えにならない。
 *
 * @param result 1回の同期(`runSync`)の結果
 * @returns 「3語 変わりました・競合1件」のような、区切り文字で連結した1行の文言
 */
export function formatSyncSummary(result: SyncRunResult): string {
  const parts: string[] = [
    result.changedTerms > 0 ? `${result.changedTerms}語 変わりました` : '変わった内容はありません',
  ];

  if (result.conflictCount > 0) parts.push(`競合${result.conflictCount}件`);
  // 統一(パソコン側の決定の取り込み)は利用者から見て内容が変わる操作なので必ず知らせる
  if (result.adoptedDecisions > 0) parts.push(`パソコン側の解消結果に${result.adoptedDecisions}件統一`);
  // 鍵が揃っていない/壊れている分は、変わらなかった理由の説明になるため件数を出す
  if (result.undecryptableBlobs > 0) parts.push(`鍵が合わず読めなかった分${result.undecryptableBlobs}件`);
  if (result.skippedBlobs > 0) parts.push(`読めなかったデータ${result.skippedBlobs}件`);

  return parts.join('・');
}

/**
 * トースト通知の文言。パネルと同じ文言に「同期しました。」を前置しただけの形にする。
 *
 * 括弧で囲む形(`同期しました(...)。`)にしないのは、変化が無い場合に
 * 「同期しました(変わった内容はありません)。」となり日本語として不自然なため(本人指定)。
 *
 * @param result 1回の同期(`runSync`)の結果
 */
export function formatSyncToast(result: SyncRunResult): string {
  return `同期しました。${formatSyncSummary(result)}`;
}
