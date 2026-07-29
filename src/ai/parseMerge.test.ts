import { describe, expect, it } from 'vitest';
import { parseMergeResponse } from './parseMerge';

describe('parseMergeResponse', () => {
  it('parses a well-formed object', () => {
    const result = parseMergeResponse(JSON.stringify({ body: '統合後の説明', diagrams: ['graph TD; A-->B'] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.body).toBe('統合後の説明');
  });

  it('defaults diagrams to an empty array when omitted', () => {
    const result = parseMergeResponse(JSON.stringify({ body: 'x' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.diagrams).toEqual([]);
  });

  it('accepts a code-fenced response', () => {
    const result = parseMergeResponse('```json\n' + JSON.stringify({ body: 'x' }) + '\n```');
    expect(result.ok).toBe(true);
  });

  it('rejects a missing body', () => {
    const result = parseMergeResponse(JSON.stringify({ diagrams: [] }));
    expect(result.ok).toBe(false);
  });

  it('rejects malformed JSON', () => {
    const result = parseMergeResponse('not json');
    expect(result.ok).toBe(false);
  });
});
