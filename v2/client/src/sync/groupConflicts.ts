import type { NoteConflictRecord } from '../types';

/**
 * 同じ単語の競合を1件にまとめる(#203)。
 *
 * **なぜ必要か。** 競合レコードは端末ごとに1件できる(`findOpenByTermAndPeer` で
 * termId + 相手端末 の組で引く)。複数の端末で同じ単語にAI検索を掛け続けると、
 * その単語の競合が端末の数だけ並ぶ。現在の表示は「この端末 / 相手」を**横に2つ**置く形で、
 * 3台以上になると収まらない。
 *
 * データ構造は既に複数台に対応している——**足りないのは表示のまとめ方**なので、
 * ここでまとめてから1枚のカードとして描く。
 */

/** まとめた結果の1枚ぶん。1単語につき1つ */
export interface ConflictGroup {
  termId: string;
  /** この語について検出されている競合(端末ごとに1件)。表示順は下記の規則で並べ済み */
  conflicts: NoteConflictRecord[];
  /** 上限を超えて表示から落とした件数。0なら全部出ている */
  hiddenCount: number;
  /** グループの代表時刻(最も新しい検出時刻)。グループ同士の並べ替えに使う */
  latestDetectedAt: number;
}

/**
 * 1枚のカードに並べる端末数の上限(本人指定)。
 * 超えた分は表示から落とし、件数だけ知らせる(落ちた競合も履歴タブからは辿れる)。
 */
export const MAX_CONFLICT_DEVICES = 5;

/**
 * 競合を単語ごとにまとめ、各グループ内を**ノートの更新が新しい順**に並べる。
 *
 * 並べ替えを「検出時刻」ではなく「相手ノートの更新時刻」にしているのは、
 * **選ぶ価値が高いのは内容が新しい端末**だから(本人判断)。同じ理由で、上限を超えた時に
 * 落とすのも更新が古い側から。
 *
 * グループ同士は最新の検出時刻が新しい順。**過去に同じ語で競合していた場合、その語の
 * グループが上に来る**——履歴が別々に散らばらず、1つの語の経緯が1箇所にまとまる。
 */
export function groupConflictsByTerm(conflicts: NoteConflictRecord[]): ConflictGroup[] {
  const byTerm = new Map<string, NoteConflictRecord[]>();
  for (const conflict of conflicts) {
    const list = byTerm.get(conflict.termId);
    if (list) list.push(conflict);
    else byTerm.set(conflict.termId, [conflict]);
  }

  const groups: ConflictGroup[] = [];
  for (const [termId, list] of byTerm) {
    const sorted = [...list].sort((a, b) => b.remote.updatedAt - a.remote.updatedAt);
    groups.push({
      termId,
      conflicts: sorted.slice(0, MAX_CONFLICT_DEVICES),
      hiddenCount: Math.max(0, sorted.length - MAX_CONFLICT_DEVICES),
      latestDetectedAt: Math.max(...list.map((c) => c.detectedAt)),
    });
  }

  return groups.sort((a, b) => b.latestDetectedAt - a.latestDetectedAt);
}

/**
 * グループの中で「この端末の内容」として見せる版を1つ選ぶ。
 *
 * `local` は競合レコードごとに持っているが、**同じ語なら本来どれも同じこの端末の内容**
 * (検出時刻がずれていれば差がありうる)。最も新しく検出されたものを採る。
 */
export function localSideOf(group: ConflictGroup): NoteConflictRecord {
  return group.conflicts.reduce((newest, c) => (c.detectedAt > newest.detectedAt ? c : newest));
}
