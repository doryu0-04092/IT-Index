import { describe, expect, it } from 'vitest';
import { createScriptedAiClient } from '../ai/testSupport';
import { resolveConflict } from './resolveConflict';

describe('resolveConflict', () => {
  it('asks the AI to merge both sides and returns the parsed proposal', async () => {
    const claude = createScriptedAiClient([JSON.stringify({ body: '統合された説明', diagrams: [] })]);

    const proposal = await resolveConflict(
      {
        termId: 'tcp/ip',
        local: { termId: 'tcp/ip', body: 'Aの説明', diagrams: [], updatedAt: 1, lastEditedBy: 'A', noteHistory: [] },
        remote: { termId: 'tcp/ip', body: 'Bの説明', diagrams: [], updatedAt: 2, lastEditedBy: 'B', noteHistory: [] },
      },
      claude,
    );

    expect(proposal?.body).toBe('統合された説明');
  });

  it('returns null when the AI output cannot be parsed (caller falls back to the deterministic result)', async () => {
    const claude = createScriptedAiClient(['壊れた応答']);

    const proposal = await resolveConflict(
      {
        termId: 'tcp/ip',
        local: { termId: 'tcp/ip', body: 'Aの説明', diagrams: [], updatedAt: 1, lastEditedBy: 'A', noteHistory: [] },
        remote: { termId: 'tcp/ip', body: 'Bの説明', diagrams: [], updatedAt: 2, lastEditedBy: 'B', noteHistory: [] },
      },
      claude,
    );

    expect(proposal).toBeNull();
  });
});
