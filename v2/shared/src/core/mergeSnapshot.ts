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
 * マージ規則のオプション(#157)。プラットフォーム名はsharedに持ち込まず、方針名で抽象化する。
 * 省略時は従来どおり(newest-wins + 競合記録)。
 */
export interface MergeOptions {
  /**
   * trueなら競合時にlocalを保持し、LWWで上書きしない(Androidネイティブ向け)。
   * 競合の決着はPC側で付け、その決定が届いたときだけ採用する(openConflictBaselines参照)。
   */
  holdLocalOnConflict?: boolean;
  /**
   * holdLocalOnConflict時のみ使用。termId → その端末で未クローズ競合が検出された時点の
   * remote.updatedAt。これより新しいremote版は「相手側(PC)の決定」とみなして採用する。
   * PC側の解消はapplyConflictResolutionでupdatedAt=現在時刻になるため必ずbaselineを超える。
   * PCが解消せず単に追加編集した場合も決定扱いになるが、PC権威モデルとして許容する(#157)。
   */
  openConflictBaselines?: Map<string, number>;
}

/** holdLocalOnConflict時に「相手側の決定」として採用したnote(呼び出し側が競合のクローズに使う) */
export interface PeerDecision {
  termId: string;
  adopted: NoteRecord;
}

export interface MergeResult {
  notes: NoteRecord[];
  conflicts: NoteConflict[];
  asks: AskRecord[];
  terms: TermRecord[];
  /** holdLocalOnConflict時のみ非空。省略モードでは常に[] */
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
    const conflictingRemote = localNote
      ? remoteNotes.find((r) => isRealConflict(localNote, r))
      : undefined;

    if (localNote === undefined || conflictingRemote === undefined) {
      // 競合なし: 両モード共通でnewest-wins
      notes.push(newest);
      continue;
    }

    if (!options?.holdLocalOnConflict) {
      // 従来動作(PC): newest-winsで先に内容を確定し、競合としても記録する
      notes.push(newest);
      conflicts.push({ termId, local: localNote, remote: conflictingRemote });
      continue;
    }

    // holdLocalOnConflict(Androidネイティブ): 競合検出時のremote版より新しい版が来ていれば
    // 「相手側(PC)の決定」とみなして採用し、そうでなければ自分の版を保持する。
    // 保持を入れないと「自分の書いた内容がLWWで勝手に変わった」状態から競合に気づくことになる。
    const baseline = options.openConflictBaselines?.get(termId);
    if (baseline !== undefined && conflictingRemote.updatedAt > baseline) {
      notes.push(conflictingRemote);
      peerDecisions.push({ termId, adopted: conflictingRemote });
    } else {
      notes.push(localNote);
      conflicts.push({ termId, local: localNote, remote: conflictingRemote });
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
