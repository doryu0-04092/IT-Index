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

  it('buckets a digit-first term under 数字', () => {
    expect(bucketOf(term('0アドレス方式', ['ゼロアドレスホウシキ']))).toBe('数字');
    expect(bucketOf(term('3Dプリンター', ['スリーディープリンター']))).toBe('数字');
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

  // 分類できない語は「その他」へ。以前は数字と一緒くたに '0-9' へ落としていたため、
  // 数字と無関係な語が「0-9」の見出しの下に並んでいた（2026-08-06修正）。
  describe('分類できない語（その他）', () => {
    it('falls back to その他 when neither the term nor its reading starts with a classifiable char', () => {
      expect(bucketOf(term('※注記', ['※チュウキ']))).toBe('その他');
      expect(bucketOf(term('ー', ['ー']))).toBe('その他');
    });

    it('falls back to その他 when readings is empty', () => {
      expect(bucketOf(term('漢字だけの語', []))).toBe('その他');
    });

    it('never puts a non-digit term into 数字', () => {
      expect(bucketOf(term('※注記', ['※チュウキ']))).not.toBe('数字');
    });
  });
});
