import { describe, expect, it } from 'vitest';
import type { AskRecord } from '../types';
import { computeWeights } from './computeWeights';

function ask(id: string, termId: string, at: number, source: AskRecord['source'] = 'ai'): AskRecord {
  return { id, termId, sessionId: source === 'ai' ? 's1' : null, at, deviceId: 'd1', source };
}

describe('computeWeights', () => {
  it('最近聞かれた語ほど高いスコアになる', () => {
    const asks = [ask('1', 'a', 1), ask('2', 'b', 2)];
    const weights = computeWeights(asks);
    expect(weights[0].termId).toBe('b');
  });

  it('その後たくさん聞かれると、聞かれなかった語は沈む', () => {
    const asks = [
      ask('1', 'a', 1),
      ...Array.from({ length: 60 }, (_, i) => ask(`n${i}`, 'noise', i + 2)),
    ];
    const weights = computeWeights(asks, 50);
    const a = weights.find((w) => w.termId === 'a')!;
    const noise = weights.find((w) => w.termId === 'noise')!;
    expect(a.weight).toBeLessThan(noise.weight);
  });

  it('マージ順序を入れ替えてもスコアが一致する（決定性）', () => {
    const asks = [ask('1', 'a', 10), ask('2', 'b', 20), ask('3', 'a', 30)];
    const shuffled = [asks[2], asks[0], asks[1]];
    expect(computeWeights(asks)).toEqual(computeWeights(shuffled));
  });

  it('(at, id) の複合キーで通し番号を安定させる（同時刻でもidでタイブレーク）', () => {
    const a = [ask('a', 'x', 100), ask('b', 'y', 100)];
    const b = [ask('b', 'y', 100), ask('a', 'x', 100)];
    expect(computeWeights(a)).toEqual(computeWeights(b));
  });

  it('AIチャット確定（source:ai）はローカル検索確定（source:search）の3倍の重みになる', () => {
    // 通し番号（i, N）の影響を受けないよう、それぞれ単独のリストで比較する
    // （N=1, i=1 なので r^(N-i)=1 になり、重みの差は倍率だけに由来する）
    const aiWeight = computeWeights([ask('1', 'a', 1, 'ai')])[0].weight;
    const searchWeight = computeWeights([ask('2', 'b', 1, 'search')])[0].weight;
    expect(aiWeight).toBeCloseTo(searchWeight * 3);
  });

  it('source が無い（この変更以前の）レコードは ai 扱いにする（後方互換）', () => {
    const legacy: AskRecord = { id: '1', termId: 'a', sessionId: 's1', at: 1, deviceId: 'd1' } as AskRecord;
    const legacyWeight = computeWeights([legacy])[0].weight;
    const searchWeight = computeWeights([ask('2', 'b', 1, 'search')])[0].weight;
    expect(legacyWeight).toBeCloseTo(searchWeight * 3);
  });
});
