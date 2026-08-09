import { buildTermRecord, validateSeedFile } from '@it-index/shared';
import type { TermsRepository } from '../repositories/terms';
import type { SettingsRepository } from '../repositories/settings';

export interface SeedImportResult {
  imported: boolean;
  /** importedがfalseの理由。検証失敗時は中止理由、既取り込み済みなら'already up to date' */
  reason?: string;
}

/**
 * 要件定義書§4.1「シード取り込み」(v1 ../../../src/seedImport.tsを移植)。
 * - versionが記録と同じなら何もしない
 * - 検証に1つでも違反があれば中止し、既存データはそのまま保持する
 *   (書き込み系リポジトリの呼び出しは検証を通過した後にしか行わない)
 */
export async function importSeed(
  fetchSeed: () => Promise<unknown>,
  termsRepo: TermsRepository,
  settingsRepo: SettingsRepository,
): Promise<SeedImportResult> {
  const settings = await settingsRepo.get();

  const raw = await fetchSeed();
  const result = validateSeedFile(raw);
  if (!result.ok) {
    return { imported: false, reason: result.reason };
  }

  if (settings.seedVersion === result.file.version) {
    return { imported: false, reason: 'already up to date' };
  }

  const now = Date.now();
  const records = result.file.terms.map((t) =>
    buildTermRecord({
      term: t.term,
      readings: t.readings,
      summary: t.summary,
      field: t.field,
      tags: t.tags,
      origin: 'seed',
      now,
    }),
  );

  await termsRepo.bulkPutFromSeed(records);
  await settingsRepo.setSeedVersion(result.file.version);

  return { imported: true };
}

export async function fetchSeedFile(url = '/seed/terms.json'): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`シードの取得に失敗しました: ${res.status}`);
  }
  return res.json();
}
