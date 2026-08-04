import { describe, expect, it } from 'vitest';
import { buildTermRecord } from '../repositories/terms';
import { bucketOf } from './kanaRow';

const now = Date.now();

function term(termText: string, readings: string[]) {
  return buildTermRecord({ term: termText, readings, summary: '', field: 'ネットワーク', origin: 'seed', now });
}

describe('bucketOf', () => {
  it('buckets a Latin-first term by its literal uppercase letter', () => {
    expect(bucketOf(term('AAC', ['エーエーシー']))).toBe('A');
  });

  it('buckets a digit-first term under 0-9', () => {
    expect(bucketOf(term('0アドレス方式', ['ゼロアドレスホウシキ']))).toBe('0-9');
    expect(bucketOf(term('3Dプリンター', ['スリーディープリンター']))).toBe('0-9');
  });

  it('buckets a dakuten-first term into its base seion character', () => {
    expect(bucketOf(term('ガベージコレクション', ['ガベージコレクション']))).toBe('カ');
  });

  it('buckets a handakuten-first term into its base seion character', () => {
    expect(bucketOf(term('パケット', ['パケット']))).toBe('ハ');
  });

  it('buckets a small-kana-first term (ッ) into ツ', () => {
    expect(bucketOf(term('ッ始まりの語', ['ッハジマリノゴ']))).toBe('ツ');
  });

  it('buckets a youon-first term (ャ) into its base seion character', () => {
    expect(bucketOf(term('ャ始まりの語', ['ャハジマリノゴ']))).toBe('ヤ');
  });

  it('buckets both ん and を into ヲ (ん has no dedicated bucket)', () => {
    expect(bucketOf(term('んから始まる語', ['ンカラハジマルゴ']))).toBe('ヲ');
    expect(bucketOf(term('をから始まる語', ['ヲカラハジマルゴ']))).toBe('ヲ');
  });

  it('falls back to readings[0] for a kanji-first term', () => {
    expect(bucketOf(term('値渡し', ['アタイワタシ']))).toBe('ア');
  });

  it('falls back to readings[0] when the first char is a long vowel mark (ー)', () => {
    expect(bucketOf(term('ー始まりの語', ['アルファ']))).toBe('ア');
  });
});
