import { describe, expect, it } from 'vitest';
import { AiApiError, translateApiError } from './errors';

describe('translateApiError', () => {
  it('translates 401 to a Japanese "wrong key" message', () => {
    expect(translateApiError(401)).toContain('キーが違います');
  });

  it('translates 429 to a rate-limit message', () => {
    expect(translateApiError(429)).toContain('多すぎます');
  });

  it('falls back to a generic message for unknown codes', () => {
    expect(translateApiError(418)).toContain('418');
  });
});

describe('AiApiError', () => {
  it('carries the provider, status, and uses the translated message', () => {
    const err = new AiApiError('anthropic', 401, '{"error":"invalid api key"}');
    expect(err.provider).toBe('anthropic');
    expect(err.status).toBe(401);
    expect(err.message).toContain('キーが違います');
    expect(err.rawBody).toContain('invalid api key');
  });

  it('works the same way for other providers', () => {
    const err = new AiApiError('openai', 429, '');
    expect(err.provider).toBe('openai');
    expect(err.message).toContain('多すぎます');
  });
});
