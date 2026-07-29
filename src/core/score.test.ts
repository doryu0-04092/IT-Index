import { describe, expect, it } from 'vitest';
import { buildTermRecord } from '../repositories/terms';
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
    const terms = [term('一意', ['イチイ']), term('TCP/IP', ['ティーシーピーアイピー'])];
    const ranked = score('1', terms);
    // "1" と "一意" は無関係であるべき（正規化しても字面が異なる）
    expect(ranked.find((r) => r.term.term === '一意')?.score).toBe(0);
  });

  it('reading にヒットする場合も拾う', () => {
    const terms = [term('API', ['エーピーアイ'])];
    const ranked = score('えーぴーあい', terms);
    expect(ranked[0].score).toBeGreaterThan(1); // 完全一致ボーナスを含む
  });
});
