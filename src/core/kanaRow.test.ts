import { describe, expect, it } from 'vitest';
import { buildTermRecord } from '../repositories/terms';
import { BUCKET_ORDER, bucketOf, bucketsOf, groupIntoBuckets, NUMERIC_BUCKET } from './kanaRow';

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

  // 2026-08-07: 先頭文字をnormalize()してから判定する。検索は正規化するのに索引だけ
  // していなかったため、全角数字・漢数字始まりの語が読み経由で無関係な行に入っていた。
  describe('先頭文字の正規化（検索と同じ基準に揃える）', () => {
    it('buckets a full-width digit term under 数字', () => {
      expect(bucketOf(term('３Dプリンタ', ['サンディープリンタ']))).toBe('数字');
    });

    it('buckets a kanji-numeral term under 数字', () => {
      expect(bucketOf(term('一次キャッシュ', ['イチジキャッシュ']))).toBe('数字');
    });

    it('buckets a full-width Latin term by its letter', () => {
      expect(bucketOf(term('Ｃ言語', ['シーゲンゴ']))).toBe('C');
    });
  });
});

// 2026-08-07: 数字始まりの語は「読みの頭」と「見出しの文字」が食い違うのが常で、
// 読みからは辿れない一方通行だった（「1」を「ワン」で探してもワ行に無い）。
describe('bucketsOf（数字始まりは読みの行にも重ねて載せる）', () => {
  it('lists a digit-first term under both 数字 and its reading row', () => {
    expect(bucketsOf(term('1', ['ワン']))).toEqual([NUMERIC_BUCKET, 'ワ']);
    expect(bucketsOf(term('1アドレス方式', ['イチアドレスホウシキ']))).toEqual([NUMERIC_BUCKET, 'イ']);
  });

  it('does not duplicate a Latin-first term into its reading row (索引が膨らむわりに得が少ないため)', () => {
    expect(bucketsOf(term('CPU', ['シーピーユー']))).toEqual(['C']);
  });

  it('does not duplicate a kana-first term', () => {
    expect(bucketsOf(term('パケット', ['パケット']))).toEqual(['ハ']);
  });

  it('lists a digit-first term only once when its reading is unusable', () => {
    expect(bucketsOf(term('9テスト語', []))).toEqual([NUMERIC_BUCKET]);
  });
});

describe('groupIntoBuckets', () => {
  // 「1」（読み: ワン）が数字バケットの最後尾（4Pの後ろ）に置かれ、見出しを開いても
  // 見つけられなかった実例の回帰テスト。数字の見出しでは数の並びで探すため読み順にしない。
  it('orders the 数字 bucket numerically, with the bare number first within each value', () => {
    const terms = [
      term('4P', ['ヨンピー']),
      term('1アドレス方式', ['イチアドレスホウシキ']),
      term('2進数', ['ニシンスウ']),
      term('1', ['ワン']),
      term('10進数', ['ジュッシンスウ']),
    ];
    const numeric = groupIntoBuckets(terms).get(NUMERIC_BUCKET)!;
    expect(numeric.map((t) => t.term)).toEqual(['1', '1アドレス方式', '2進数', '4P', '10進数']);
  });

  it('still orders non-numeric buckets by reading', () => {
    const terms = [term('値渡し', ['アタイワタシ']), term('アクセス', ['アクセス'])];
    expect(groupIntoBuckets(terms).get('ア')!.map((t) => t.term)).toEqual(['アクセス', '値渡し']);
  });

  // 読みが空の語が1件でも他の語と同じバケットに入ると undefined.localeCompare で例外になり、
  // 単語一覧の画面全体が「読み込み中です…」で停止していた（実データで再現済み）。
  it('does not throw when a term with no readings shares a bucket with others', () => {
    const terms = [term('1アドレス方式', ['イチアドレスホウシキ']), term('9テスト語', [])];
    expect(() => groupIntoBuckets(terms)).not.toThrow();
    expect(groupIntoBuckets(terms).get(NUMERIC_BUCKET)!).toHaveLength(2);
  });

  // 索引から語が抜け落ちないことの担保。bucketOf は全域関数なので構造上は起きないが、
  // 分類規則を変えるたびにここで固定しておく。
  it('places every term into at least one rendered bucket', () => {
    const terms = [
      term('AAC', ['エーエーシー']),
      term('1', ['ワン']),
      term('３Dプリンタ', ['サンディープリンタ']),
      term('一次キャッシュ', ['イチジキャッシュ']),
      term('値渡し', ['アタイワタシ']),
      term('※注記', ['※チュウキ']),
      term('読み欠落テスト', []),
    ];
    const buckets = groupIntoBuckets(terms);

    for (const t of terms) {
      const found = [...buckets.values()].filter((list) => list.some((x) => x.id === t.id));
      expect(found.length, `${t.term} がどのバケットにも入っていない`).toBeGreaterThanOrEqual(1);
    }
    expect([...buckets.keys()].every((b) => (BUCKET_ORDER as readonly string[]).includes(b))).toBe(true);
  });
});
