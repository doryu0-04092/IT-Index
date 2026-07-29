import { describe, expect, it } from 'vitest';
import { getProviderInfo, PROVIDERS } from './types';

describe('PROVIDERS / getProviderInfo', () => {
  it('lists the three supported providers', () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual(['anthropic', 'openai', 'gemini']);
  });

  it('getProviderInfo returns the matching entry', () => {
    expect(getProviderInfo('anthropic').defaultModel).toBe('claude-sonnet-5');
  });
});
