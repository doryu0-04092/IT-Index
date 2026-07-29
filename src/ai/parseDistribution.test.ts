import { describe, expect, it } from 'vitest';
import { parseDistributionResponse } from './parseDistribution';

function validJson() {
  return JSON.stringify([
    {
      term: 'TCP/IP',
      isTerm: true,
      askedByUser: true,
      summary: '層に分けた通信規約の集まり。',
      readings: ['ティーシーピーアイピー'],
      field: 'ネットワーク',
      draftBody: '説明文',
      diagrams: [],
    },
  ]);
}

describe('parseDistributionResponse', () => {
  it('parses a well-formed array', () => {
    const result = parseDistributionResponse(validJson());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items).toHaveLength(1);
  });

  it('accepts responses wrapped in a ```json code fence', () => {
    const result = parseDistributionResponse('```json\n' + validJson() + '\n```');
    expect(result.ok).toBe(true);
  });

  it('accepts an empty array (no terms discussed)', () => {
    const result = parseDistributionResponse('[]');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items).toEqual([]);
  });

  it('accepts isTerm:false items without readings/field/draftBody', () => {
    const raw = JSON.stringify([{ term: '今日の天気', isTerm: false }]);
    const result = parseDistributionResponse(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items[0]).toEqual({ term: '今日の天気', isTerm: false, diagrams: [] });
  });

  it('rejects a field outside the fixed 24-category list', () => {
    const items = JSON.parse(validJson());
    items[0].field = 'そんな分野はない';
    const result = parseDistributionResponse(JSON.stringify(items));
    expect(result.ok).toBe(false);
  });

  it('rejects isTerm:true items with empty readings', () => {
    const items = JSON.parse(validJson());
    items[0].readings = [];
    const result = parseDistributionResponse(JSON.stringify(items));
    expect(result.ok).toBe(false);
  });

  it('rejects isTerm:true items missing askedByUser', () => {
    const items = JSON.parse(validJson());
    delete items[0].askedByUser;
    const result = parseDistributionResponse(JSON.stringify(items));
    expect(result.ok).toBe(false);
  });

  it('parses askedByUser:false for terms the AI only mentioned in passing', () => {
    const items = JSON.parse(validJson());
    items[0].askedByUser = false;
    const result = parseDistributionResponse(JSON.stringify(items));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items[0]).toMatchObject({ askedByUser: false });
  });

  it('rejects isTerm:true items missing summary', () => {
    const items = JSON.parse(validJson());
    delete items[0].summary;
    const result = parseDistributionResponse(JSON.stringify(items));
    expect(result.ok).toBe(false);
  });

  it('rejects isTerm:true items with an empty summary', () => {
    const items = JSON.parse(validJson());
    items[0].summary = '';
    const result = parseDistributionResponse(JSON.stringify(items));
    expect(result.ok).toBe(false);
  });

  it('rejects malformed JSON', () => {
    const result = parseDistributionResponse('not json at all');
    expect(result.ok).toBe(false);
  });

  it('rejects a non-array root', () => {
    const result = parseDistributionResponse('{"term": "TCP/IP"}');
    expect(result.ok).toBe(false);
  });
});
