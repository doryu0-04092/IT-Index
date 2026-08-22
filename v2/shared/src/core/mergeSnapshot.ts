import type { AskRecord, NoteRecord, TermRecord } from '../types';

/** device-*.json の中身。docs/architecture.md §4.2「同期ファイルの構造」 */
export interface SyncFile {
  syncSchemaVersion: 1;
  deviceId: string;
  writtenAt: number;
  notes: NoteRecord[];
  asks: AskRecord[];
  aiTerms: TermRecord[];
}

/** 現端末のローカルデータのうち、同期対象部分だけを渡す */
export interface LocalSnapshot {
  notes: NoteRecord[];
  asks: AskRecord[];
  aiTerms: TermRecord[];
}

/** 両端末で更新され、決定的コードでは判断できない箇所（要件定義書 §5.5） */
export interface NoteConflict {
  termId: string;
  local: NoteRecord;
  remote: NoteRecord;
}

/**
 * マージ規則のオプション(#157 → #234で意味を変更)。
 *
 * **競合中は常に自分の版を保持する。** 以前は端末の種類で挙動を分けていた
 * (Androidは保持・PCはnewest-wins)が、PC側で「利用者が何もしていないのに自分の本文が
 * 相手の版へ置き換わる」ことが実測で分かったため、保持に統一した。
 */
export interface MergeOptions {
  /**
   * trueなら競合時にlocalを保持し、LWWで上書きしない(Androidネイティブ向け)。
   * 競合の決着はPC側で付け、その決定が届いたときだけ採用する(openConflictBaselines参照)。
   */

  /**
   * termId → その端末で未クローズ競合が検出された時点の
   * remote.updatedAt。これより新しいremote版は「相手側(PC)の決定」とみなして採用する。
   * PC側の解消はapplyConflictResolutionでupdatedAt=現在時刻になるため必ずbaselineを超える。
   * PCが解消せず単に追加編集した場合も決定扱いになるが、PC権威モデルとして許容する(#157)。
   */
  openConflictBaselines?: Map<string, number>;
}

/** 「相手側の決定」として採用したnote(呼び出し側が競合のクローズに使う) */
export interface PeerDecision {
  termId: string;
  adopted: NoteRecord;
}

export interface MergeResult {
  notes: NoteRecord[];
  conflicts: NoteConflict[];
  asks: AskRecord[];
  terms: TermRecord[];
  /** 相手の解消を採用した時だけ非空 */
  peerDecisions: PeerDecision[];
}

/**
 * 決定的マージ。AIを使わず規則だけで行う（docs/requirements.md §5.5）。
 * - notes: updatedAt が新しい方を採用。ただし local と remote の内容が食い違う場合は
 *   conflicts にも積む（AIによる統合は任意の追加提案であり、ここでの newest-wins が
 *   鍵の無い状態でも単独で完結するフォールバックになる）
 * - asks: id で和集合
 * - terms（origin:'ai' の語）: id で和集合。同一 id は updatedAt が新しい方
 *
 * 同じスナップショットを2回マージしても結果が変わらない（冪等）ことをテストで固める対象。
 */
export function mergeSnapshot(
  local: LocalSnapshot,
  remoteFiles: SyncFile[],
  options?: MergeOptions,
): MergeResult {
  const notes: NoteRecord[] = [];
  const conflicts: NoteConflict[] = [];
  const peerDecisions: PeerDecision[] = [];

  const termIds = new Set<string>();
  local.notes.forEach((n) => termIds.add(n.termId));
  remoteFiles.forEach((f) => f.notes.forEach((n) => termIds.add(n.termId)));

  for (const termId of termIds) {
    const localNote = local.notes.find((n) => n.termId === termId);
    const remoteNotes = remoteFiles.flatMap((f) => f.notes).filter((n) => n.termId === termId);
    const candidates = [...(localNote ? [localNote] : []), ...remoteNotes];

    const newest = [...candidates].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    // 競合相手は「最も新しい競合版」を採る(#169)。find(=最初に見つかった版)だと、1回のpullに
    // 同じ端末の古いblobと解消後のblobが両方入った場合に古い方を拾ってしまい、
    // 「baselineより新しくない=相手側の決定ではない」と誤判定して解消結果をバッチごと捨てていた
    // (PC解消→PC同期→Android同期の自然な1往復で統一されない実バグ)。
    // 競合している相手を**端末ごとに1件**に畳む(#224)。
    //
    // 以前は最も新しい競合版1台だけを見ていたため、3台以上で編集しても competing する
    // 相手が1件しか記録されず、画面は常に「この端末＋相手1台」の2行しか描けなかった
    // (#203 は表示のまとめ方を直したが、まとめる材料が1件しか無かった)。
    //
    // **notes の勝者は1件のまま**(1語1note)で、competing する相手だけを複数持つ。
    // 同じ端末の blob が1回のpullに複数入る場合があるので、端末ごとに最も新しい版へ畳む
    // (#169と同じ理由: 古い版を拾うと解消結果を取りこぼす)。
    const conflictingByDevice = new Map<string, NoteRecord>();
    if (localNote) {
      for (const r of remoteNotes) {
        if (!isRealConflict(localNote, r)) continue;
        const current = conflictingByDevice.get(r.lastEditedBy);
        if (current === undefined || r.updatedAt > current.updatedAt) {
          conflictingByDevice.set(r.lastEditedBy, r);
        }
      }
    }
    const conflictingRemotes = [...conflictingByDevice.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    // 内容の採否(相手の解消を採用するかの判定)は**最も新しい1件**で決める
    const conflictingRemote = conflictingRemotes[0];

    if (localNote === undefined || conflictingRemote === undefined) {
      // 競合なし: 両モード共通でnewest-wins
      notes.push(newest);
      continue;
    }

    /*
     * **競合したら自分の版を保持する(#234)。相手の内容を採るのは、それが解消の結果の時だけ。**
     *
     * 以前はPC側だけ newest-wins で内容を確定していたため、**利用者が何もしていないのに
     * 自分の書いた本文が相手の版へ置き換わっていた**(しかも noteHistory にも残らず、
     * 競合レコードのスナップショットにしか残らなかった)。実測で確認して方針を変えた。
     *
     * 採用の条件は2つとも要る:
     *
     * 1. `resolvedAt` がある = **相手が競合を解消した結果**である。
     *    単なる追加編集を「決定」と扱うと、結局は黙って上書きされることになる
     *    (#157はこれを「PC権威モデルとして許容する」としていたが、方針を変えた)
     * 2. 競合検出時に見た版より新しい = **まだ取り込んでいない解消**である。
     *    古い解消を採ると、こちらが後から決めた内容が巻き戻る
     *
     * baselineが無い(=この語の競合をまだ記録していない)場合は採用しない。
     * 初めて競合を検出した回に相手の解消を採ると、こちらの利用者が一度も見ないまま
     * 内容が変わることになるため。
     */
    const baseline = options?.openConflictBaselines?.get(termId);
    /*
     * 解消の版は**競合相手に限定せず**、この語のremote全体から探す。
     *
     * 限定すると取りこぼす: 相手が解消した内容がこちらの過去版と一致していると
     * `isRealConflict` が false になり(「相手はこちらの過去版を持っているだけ」の判定)、
     * 競合相手の一覧から外れる。他の端末とはまだ競合しているので保持の分岐に入り、
     * **相手の決定が捨てられる**。5端末の繰り返しシナリオで実際に踏んだ。
     */
    const peerDecision = remoteNotes
      .filter(
        (r) =>
          // 値が入っている時だけ解消の結果とみなす(undefinedは「解消していない」)
          typeof r.resolvedAt === 'number' &&
          // こちらの版より新しい解消だけを採る。同じか古いものは既に反映済みか、巻き戻し
          r.updatedAt > localNote.updatedAt &&
          // 競合を記録済みなら、その時に見た版より新しいことも要る。
          // baselineが無い(=まだ競合を見ていない)場合もここは通す——**通さないと、
          // 一度も競合を見ていない端末に解消結果が永久に届かない**(実ブラウザで踏んだ)
          (baseline === undefined || r.updatedAt > baseline),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];

    if (peerDecision !== undefined) {
      notes.push(peerDecision);
      peerDecisions.push({ termId, adopted: peerDecision });
    } else {
      notes.push(localNote);
      // 競合は相手ごとに記録する(#224)——採用される内容は1つでも、
      // 「誰と食い違っているか」は端末の数だけある
      for (const remote of conflictingRemotes) conflicts.push({ termId, local: localNote, remote });
    }
  }

  const askMap = new Map<string, AskRecord>();
  local.asks.forEach((a) => askMap.set(a.id, a));
  remoteFiles.forEach((f) => f.asks.forEach((a) => askMap.set(a.id, a)));

  const termMap = new Map<string, TermRecord>();
  local.aiTerms.forEach((t) => termMap.set(t.id, t));
  remoteFiles.forEach((f) =>
    f.aiTerms.forEach((t) => {
      const existing = termMap.get(t.id);
      if (!existing || t.updatedAt > existing.updatedAt) termMap.set(t.id, t);
    }),
  );

  return {
    notes,
    conflicts,
    asks: [...askMap.values()],
    terms: [...termMap.values()],
    peerDecisions,
  };
}

/** src/core/syncDelta.ts でも使う（内容比較。updatedAt/lastEditedByは見ない） */
export function isSameContent(a: NoteRecord, b: NoteRecord): boolean {
  return a.body === b.body && JSON.stringify(a.diagrams) === JSON.stringify(b.diagrams);
}

/**
 * 「両方の端末が**それぞれ独自に**編集した」と言えるものだけを競合として扱う（2026-08-05）。
 *
 * 以前は「内容が違えば競合」としていたが、それでは**片方でしか編集していない場合も競合になる**。
 * 例: PCで語Aを育てる → 連携でAndroidへコピー → その後PCだけでさらに育てる → もう一度連携。
 * このときAndroidは何もしていないのに、持っている内容はPCの古い版なので「内容が違う」に該当し、
 * 競合として数え上げられていた。連携のたびに本物でない競合が並ぶと、確認画面が見られなくなる。
 *
 * この実装は共通の祖先を記録していない（3-wayマージではない）ため、次の2つの手掛かりで
 * 「相手は独自に編集していない」と言い切れる場合を競合から外す:
 *
 * 1. **`lastEditedBy` が同じ** — 相手が持っているのは同じ端末が書いた版。相手はそれを
 *    受け取っただけで、自分では書いていない
 * 2. **相手の内容がこちらの過去版そのもの** — `noteHistory` は上書き前の版の積み重ね
 *    （`NotesRepository.applyCommit`）。ここに一致があれば、相手はこちらの古い版を
 *    持っているだけで、単に遅れている
 *
 * どちらにも当てはまらない場合だけを競合として残す。なお相手の `noteHistory` は同期で
 * 送られてこない（端末ローカルな記録のため `stripNoteHistory` で落としている）ので、
 * 2の判定は「こちらが進んでいる」向きにしか効かない。逆向き（こちらが遅れている）は
 * 1の `lastEditedBy` 判定で拾う。
 */
function isRealConflict(localNote: NoteRecord, remoteNote: NoteRecord): boolean {
  if (isSameContent(remoteNote, localNote)) return false;
  if (remoteNote.lastEditedBy === localNote.lastEditedBy) return false;

  const remoteIsOurPastVersion = localNote.noteHistory.some(
    (h) => h.body === remoteNote.body && JSON.stringify(h.diagrams) === JSON.stringify(remoteNote.diagrams),
  );
  return !remoteIsOurPastVersion;
}
