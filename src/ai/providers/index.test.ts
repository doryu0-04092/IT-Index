import { describe, expect, it } from 'vitest';
import { createDynamicAiClient } from './index';

describe('createDynamicAiClient', () => {
  it('throws a clear error when no credential is set, without hitting the network', async () => {
    const client = createDynamicAiClient(() => null);

    await expect(client.send({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
      'APIキーが設定されていません',
    );
  });
});
