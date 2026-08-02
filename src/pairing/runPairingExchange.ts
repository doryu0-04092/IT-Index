/**
 * LAN直結ペアリングの中核。QRで渡した使い捨て鍵を使い、暗号化した全量スナップショットの
 * 封筒を作る／開いてマージするだけを担う（HTTP送受信は呼び出し側の責務）。
 *
 * 待ち受け側・接続役どちらも同じ2関数を呼ぶだけで完全に対称になる：
 *   待ち受け側: openAndMerge → sealSnapshot して返す
 *   接続役    : sealSnapshot して送る → 返ってきたものを openAndMerge
 */
import type { NoteConflict } from '../core/mergeSnapshot';
import { exportFullSnapshot, importSyncFiles, type ManualSyncDeps } from '../manualSync/sync';
import { open, seal } from './crypto';

export type PairingResult =
  | { ok: true; mergedNoteCount: number; conflicts: NoteConflict[]; skippedFiles: string[] }
  | { ok: false; reason: string };

/** 自分が知っている全部を暗号化して送出用の封筒にする */
export async function sealSnapshot(key: CryptoKey, deps: ManualSyncDeps): Promise<string> {
  const { content } = await exportFullSnapshot(deps);
  return seal(key, content);
}

/** 受け取った封筒を復号し、ローカルへマージする */
export async function openAndMerge(key: CryptoKey, envelope: string, deps: ManualSyncDeps): Promise<PairingResult> {
  const content = await open(key, envelope);
  if (content === null) {
    return { ok: false, reason: '鍵が合いません。QRを読み直してください。' };
  }

  const result = await importSyncFiles([{ name: 'pairing', content }], deps);
  return { ok: true, mergedNoteCount: result.mergedNoteCount, conflicts: result.conflicts, skippedFiles: result.skippedFiles };
}
