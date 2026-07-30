import { normalize } from '../core/normalize';
import type { NotesRepository } from '../repositories/notes';
import { buildTermRecord, makeTermId, type TermsRepository } from '../repositories/terms';
import type { TermRecord } from '../types';
import { parseNoteFile } from './noteFile';
import { validateLocalTermsFile } from './termsFile';

/**
 * フォルダから読み出した生ファイル。I/O（File System Access API）はこのモジュールの外で行う
 * ——このファイルは純関数として repository のみに依存し、テストしやすくする。
 */
export interface LocalDataFiles {
  /** `data/terms.json` の生テキスト。ファイルがまだ無ければ undefined */
  termsJson: string | undefined;
  /** `data/notes/*.md`。`termId` はファイル名（拡張子なし） */
  notes: { termId: string; content: string }[];
}

export interface ImportLocalDataResult {
  ok: boolean;
  /** ok:false の中止理由 */
  reason?: string;
  addedTerms: number;
  updatedTerms: number;
  tombstonedTerms: number;
  appliedNotes: number;
  /** termId が既存語のどれとも一致しなかった notes ファイル（反映できなかった） */
  skippedNotes: string[];
}

/**
 * 削除の安全弁（docs/local-data.md）。ファイルから消えた origin:'ai' 語をそのまま tombstone に
 * すると、Claude Code の誤削除や書き込み途中のファイル読み取りで大量消失が起き得るため、
 * 減少がこの件数、または既存件数のこの割合を超えたら取り込みを中止する。
 */
const DELETE_SAFEGUARD_MIN_COUNT = 20;
const DELETE_SAFEGUARD_RATIO = 0.1;

function emptyResult(): ImportLocalDataResult {
  return { ok: true, addedTerms: 0, updatedTerms: 0, tombstonedTerms: 0, appliedNotes: 0, skippedNotes: [] };
}

/**
 * `data/terms.json` + `data/notes/*.md` を IndexedDB へ取り込む。
 * 1つでも検証に違反があれば terms.json 側は全件中止する（既存の `validateSeedFile` と同じ方針）。
 * `summary` は常に既存値を保持する（不変ルール。ファイル側の値は読み取らない）。
 */
export async function importLocalData(
  files: LocalDataFiles,
  deps: { termsRepo: TermsRepository; notesRepo: NotesRepository; deviceId: string },
  now: number = Date.now(),
): Promise<ImportLocalDataResult> {
  if (files.termsJson === undefined) {
    // 初回セットアップ直後など、まだ terms.json 自体が無い状態。中止ではなく「何もない」を返す。
    return emptyResult();
  }

  let raw: unknown;
  try {
    raw = JSON.parse(files.termsJson);
  } catch {
    return { ...emptyResult(), ok: false, reason: 'data/terms.json の構文が不正です' };
  }

  const validated = validateLocalTermsFile(raw);
  if (!validated.ok) {
    return { ...emptyResult(), ok: false, reason: `data/terms.json の検証に失敗しました: ${validated.reason}` };
  }

  const allTerms = await deps.termsRepo.getAll();
  const existingAiTerms = allTerms.filter((t) => t.origin === 'ai');
  const existingById = new Map(existingAiTerms.map((t) => [t.id, t]));

  const incoming = validated.file.terms.map((t) => ({ ...t, id: makeTermId(t.term) }));
  const incomingIds = new Set(incoming.map((t) => t.id));

  const removedIds = existingAiTerms.map((t) => t.id).filter((id) => !incomingIds.has(id));
  const threshold = Math.max(
    DELETE_SAFEGUARD_MIN_COUNT,
    Math.ceil(existingAiTerms.length * DELETE_SAFEGUARD_RATIO),
  );
  if (removedIds.length > threshold) {
    return {
      ...emptyResult(),
      ok: false,
      reason: `data/terms.json から ${removedIds.length}語が消えています（しきい値: ${threshold}語）。誤削除の可能性があるため取り込みを中止しました。`,
    };
  }

  let addedTerms = 0;
  let updatedTerms = 0;
  const knownTermIds = new Set(allTerms.map((t) => t.id));

  for (const item of incoming) {
    const existing = existingById.get(item.id);
    if (!existing) {
      const record = buildTermRecord({
        term: item.term,
        readings: item.readings,
        // 空文字は「初期説明なし」を意味する（buildLocalTermsFile が summary:null をこう書き出す）
        summary: item.summary === '' ? null : item.summary,
        field: item.field,
        tags: item.tags,
        origin: 'ai',
        now,
      });
      await deps.termsRepo.upsertFromAi(record);
      knownTermIds.add(record.id);
      addedTerms++;
      continue;
    }

    const nextTags = item.tags ?? [];
    const changed =
      JSON.stringify(existing.readings) !== JSON.stringify(item.readings) ||
      existing.field !== item.field ||
      JSON.stringify(existing.tags) !== JSON.stringify(nextTags);
    if (!changed) continue;

    const updated: TermRecord = {
      ...existing,
      // summary は書き換えない（不変ルール。ファイル側の値は無視する）
      readings: item.readings,
      field: item.field,
      tags: nextTags,
      searchKey: normalize(item.term),
      readingKeys: item.readings.map(normalize),
      updatedAt: now,
    };
    await deps.termsRepo.upsertFromAi(updated);
    updatedTerms++;
  }

  let tombstonedTerms = 0;
  for (const id of removedIds) {
    const existing = existingById.get(id);
    if (!existing) continue;
    await deps.termsRepo.upsertFromAi({ ...existing, deletedAt: now, updatedAt: now });
    tombstonedTerms++;
  }

  let appliedNotes = 0;
  const skippedNotes: string[] = [];
  for (const file of files.notes) {
    if (!knownTermIds.has(file.termId)) {
      skippedNotes.push(file.termId);
      continue;
    }
    const { body, diagrams } = parseNoteFile(file.content);
    await deps.notesRepo.applyCommit(file.termId, body, diagrams, deps.deviceId, now);
    appliedNotes++;
  }

  return { ok: true, addedTerms, updatedTerms, tombstonedTerms, appliedNotes, skippedNotes };
}
