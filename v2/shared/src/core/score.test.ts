import { describe, expect, it } from 'vitest';
import { buildTermRecord } from './term';
import { score } from './score';

const now = Date.now();

function term(term: string, readings: string[]) {
  return buildTermRecord({ term, readings, summary: '', field: 'ネットワーク', origin: 'seed', now });
}

describe('score', () => {
  it('ranks 長音差を1文字差として上位に残す（サーバー→サーバ）', () => {
    const terms = [term('サーバ', ['サーバ']), term('クライアント', ['クライアント'])];
    const ranked = score('サーバー', terms);
    expect(ranked[0].term.term).toBe('サーバ');
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it('ranks a typo close to the correct spelling (TCP/PI -> TCP/IP)', () => {
    const terms = [term('TCP/IP', ['ティーシーピーアイピー']), term('UDP', ['ユーディーピー'])];
    const ranked = score('TCP/PI', terms);
    expect(ranked[0].term.term).toBe('TCP/IP');
  });

  it('does not let a single-character query dominate unrelated long terms', () => {
    const terms = [term('キャッシュ', ['キャッシュ']), term('TCP/IP', ['ティーシーピーアイピー'])];
    const ranked = score('1', terms);
    // "1" と "キャッシュ" は無関係であるべき
    expect(ranked.find((r) => r.term.term === 'キャッシュ')?.score).toBe(0);
  });

  it('漢数字を算用数字に正規化して拾う（三層 ↔ 3層、#36対応）', () => {
    const terms = [term('3層アーキテクチャ', ['さんそうあーきてくちゃ']), term('TCP/IP', ['ティーシーピーアイピー'])];
    const ranked = score('三層', terms);
    expect(ranked[0].term.term).toBe('3層アーキテクチャ');
    expect(ranked[0].score).toBeGreaterThan(0);
  });

  it('reading にヒットする場合も拾う', () => {
    const terms = [term('API', ['エーピーアイ'])];
    const ranked = score('えーぴーあい', terms);
    expect(ranked[0].score).toBeGreaterThan(1); // 完全一致ボーナスを含む
  });
});
