/**
 * LAN直結ペアリングの中核。QRで渡した使い捨て鍵を使い、暗号化した全量スナップショットの
 * 封筒を作る／開いてマージするだけを担う（HTTP送受信は呼び出し側の責務）。
 *
 * 待ち受け側・接続役どちらも同じ2関数を呼ぶだけで完全に対称になる：
 *   待ち受け側: sealSnapshot して返す準備 → openAndMerge → 用意しておいた封筒を返す
 *   接続役    : sealSnapshot して送る → 返ってきたものを openAndMerge
 *
 * 待ち受け側は必ず「自分のスナップショットを先に封印してから」相手の分をマージする
 * （2026-08-05修正）。以前はマージを先に行っていたため、返信スナップショットに
 * 「相手から今取り込んだばかりのデータ」がそのまま混ざってしまい、相手が
 * 「自分が新しく渡したものは何件か」を返信から正確に算出できなかった
 * （受け取った件数は自分の取り込み前後の差分で常に正確に出せるが、送った件数だけが
 * 不正確になる非対称構造だった）。順序を入れ替えても mergeSnapshot は冪等なため、
 * 最終的な同期結果自体は変わらない。
 */
import type { SyncFile } from '../core/mergeSnapshot';
import { computeSyncDelta, type SyncDelta } from '../core/syncDelta';
import { parseSyncFile } from '../core/validateSyncFile';
import { buildFullSnapshot, importSyncFiles, type ManualSyncDeps } from '../manualSync/sync';
import type { NoteConflictRecord } from '../types';
import { open, seal } from './crypto';

export interface SealedSnapshot {
  /** 相手へ送る暗号化済みの封筒 */
  envelope: string;
  /** 封印前の中身。相手からの返信を受け取った際、送受信の差分計算に使う */
  file: SyncFile;
}

export interface PairingStats {
  /** この exchange で相手に新しく渡った単語・ノート（自分の送信内容と相手の受信前内容の差分） */
  sentDelta: SyncDelta;
  /** この exchange で相手から新しく受け取った単語・ノート */
  receivedDelta: SyncDelta;
  /** 相手端末の deviceId（取り込み履歴で相手を区別するためだけに使う。表示名は無い） */
  peerDeviceIds: string[];
}

export type PairingResult =
  | ({ ok: true; conflicts: NoteConflictRecord[]; skippedFiles: string[] } & PairingStats)
  | { ok: false; reason: string };

/** 自分が知っている全部を暗号化して送出用の封筒にする */
export async function sealSnapshot(key: CryptoKey, deps: ManualSyncDeps): Promise<SealedSnapshot> {
  const file = await buildFullSnapshot(deps);
  const envelope = await seal(key, JSON.stringify(file));
  return { envelope, file };
}

/**
 * 受け取った封筒を復号し、ローカルへマージする。
 * `mine` を渡すと、相手のスナップショットと自分のスナップショット（取り込み前の状態）を
 * 比較して「自分が相手に渡した分（sentDelta）」も計算する。渡さない場合は空扱いになる
 * （このやり取りで自分から何も送っていない場合や、送信側の差分に関心が無い場合向け）。
 */
export async function openAndMerge(
  key: CryptoKey,
  envelope: string,
  deps: ManualSyncDeps,
  mine?: SyncFile,
): Promise<PairingResult> {
  const content = await open(key, envelope);
  if (content === null) {
    return { ok: false, reason: '鍵が合いません。QRを読み直してください。' };
  }

  const result = await importSyncFiles([{ name: 'pairing', content }], deps);

  let sentDelta: SyncDelta = { termIds: [], noteTermIds: [] };
  if (mine) {
    const parsed = parseSyncFile(JSON.parse(content));
    if (parsed.ok) {
      sentDelta = computeSyncDelta(parsed.file, mine);
    }
  }

  return {
    ok: true,
    sentDelta,
    receivedDelta: result.receivedDelta,
    peerDeviceIds: result.peerDeviceIds,
    conflicts: result.conflicts,
    skippedFiles: result.skippedFiles,
  };
}
