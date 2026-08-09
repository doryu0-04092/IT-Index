import type { TermRecord } from '../types';

/**
 * 端末間同期に載せる語かどうか（docs/architecture.md §2 の例外規定）。
 *
 * 原則は `origin: 'ai'` の語だけ——内蔵シードは両端末が同じものを持つ前提なので送る必要が無い。
 * ただし**削除（tombstone）は origin を問わず載せる**。利用者が明示的に消した語は、
 * どちらの端末で消しても両方に反映されるべきで、これを送らないと相手が持っている削除前の
 * レコードがマージで戻ってきてしまう（実際に起きていた不具合）。
 *
 * 送信側（localSnapshot / exportFullSnapshot）と受信側の検証（validateSyncFile）の
 * 両方がこの1つの判定を参照する——片方だけ緩めると、送ったのに相手に弾かれる／
 * その逆が起きるため。
 */
export function isSyncTarget(term: Pick<TermRecord, 'origin' | 'deletedAt'>): boolean {
  return term.origin === 'ai' || term.deletedAt !== null;
}
