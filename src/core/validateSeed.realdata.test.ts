import { describe, expect, it } from 'vitest';
import seedRaw from '../../public/seed/terms.json';
import { makeTermId } from '../repositories/terms';
import { validateSeedFile } from './validateSeed';

describe('validateSeedFile against the actual public/seed/terms.json', () => {
  it('passes validation', () => {
    const result = validateSeedFile(seedRaw);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.file.terms.length).toBeGreaterThan(0);
  });

  it('produces no id collisions via makeTermId(term), even though term itself has no duplicates', () => {
    // term の重複は validateSeedFile が弾くが、normalize() で異なる term が
    // 同じ id に潰れるケース（例: 表記ゆれ違いの全角/半角）は別チェックが要る。
    const result = validateSeedFile(seedRaw);
    if (!result.ok) throw new Error(result.reason);

    const idToTerms = new Map<string, string[]>();
    for (const t of result.file.terms) {
      const id = makeTermId(t.term);
      const list = idToTerms.get(id) ?? [];
      list.push(t.term);
      idToTerms.set(id, list);
    }

    const collisions = [...idToTerms.entries()].filter(([, terms]) => terms.length > 1);
    expect(collisions).toEqual([]);
  });
});
