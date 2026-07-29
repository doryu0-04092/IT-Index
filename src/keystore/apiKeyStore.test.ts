import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ItIndexDB } from '../db';
import { createKeyStoreRepository } from '../repositories/keyStore';
import { createApiKeyStore, getSessionCredential, clearSessionCredential, type AiCredential } from './apiKeyStore';
import { randomBytes } from './randomBytes';
import type { PasskeyRegistration, WebAuthnClient } from './webauthn';

const SAMPLE_CREDENTIAL: AiCredential = { provider: 'anthropic', apiKey: 'sk-ant-abc123', model: 'claude-sonnet-5' };

/**
 * 実際の認証器の代わりに、credentialId ごとに固定の32バイトを返すフェイク。
 * `prfOutputAtCreate: true`（既定）は「create() 時点でPRF出力まで得られる対応ブラウザ」を模す
 * （1回の認証儀式で完結し、getPrfOutput は呼ばれない）。false にすると、従来どおり
 * registerPasskey() は prfOutput: null を返し、呼び出し側が改めて getPrfOutput() を呼ぶ
 * フォールバック経路（＝2回目の認証儀式）を模す。
 */
function createFakeWebAuthnClient(
  options: { available?: boolean; prfSupported?: boolean; prfOutputAtCreate?: boolean } = {},
): WebAuthnClient & { getPrfOutputCallCount: () => number } {
  const { available = true, prfSupported = true, prfOutputAtCreate = true } = options;
  const outputs = new Map<string, ArrayBuffer>();
  let getPrfOutputCallCount = 0;

  return {
    isAvailable: () => available,

    async registerPasskey(): Promise<PasskeyRegistration> {
      const credentialId = randomBytes(16).buffer;
      const output = randomBytes(32).buffer;
      outputs.set(bufferKey(credentialId), output);
      return { credentialId, prfSupported, prfOutput: prfSupported && prfOutputAtCreate ? output : null };
    },

    async getPrfOutput(credentialId) {
      getPrfOutputCallCount += 1;
      return outputs.get(bufferKey(credentialId)) ?? null;
    },

    getPrfOutputCallCount: () => getPrfOutputCallCount,
  };
}

function bufferKey(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

describe('ApiKeyStore', () => {
  let db: ItIndexDB;

  beforeEach(() => {
    db = new ItIndexDB(`test-keystore-${crypto.randomUUID()}`);
    clearSessionCredential();
  });

  afterEach(async () => {
    await db.delete();
    clearSessionCredential();
  });

  it('enablePersistence then tryRestore (fresh session) recovers the same credential', async () => {
    const repo = createKeyStoreRepository(db);
    const webauthn = createFakeWebAuthnClient();
    const store = createApiKeyStore(repo, webauthn);

    await store.enablePersistence(SAMPLE_CREDENTIAL);
    expect(getSessionCredential()).toEqual(SAMPLE_CREDENTIAL);

    clearSessionCredential(); // タブを閉じて再度開いた状況を模す
    const restored = await store.tryRestore();

    expect(restored).toBe(true);
    expect(getSessionCredential()).toEqual(SAMPLE_CREDENTIAL);
  });

  it('enablePersistence completes with a single WebAuthn ceremony when create() returns PRF output directly (regression: バグ8, double-prompt)', async () => {
    const repo = createKeyStoreRepository(db);
    const webauthn = createFakeWebAuthnClient({ prfOutputAtCreate: true });
    const store = createApiKeyStore(repo, webauthn);

    await store.enablePersistence(SAMPLE_CREDENTIAL);

    expect(webauthn.getPrfOutputCallCount()).toBe(0); // getPrfOutput（＝2回目の認証儀式）は呼ばれない
    expect(getSessionCredential()).toEqual(SAMPLE_CREDENTIAL);
  });

  it('enablePersistence falls back to a second ceremony when create() does not return PRF output (older browser behavior)', async () => {
    const repo = createKeyStoreRepository(db);
    const webauthn = createFakeWebAuthnClient({ prfOutputAtCreate: false });
    const store = createApiKeyStore(repo, webauthn);

    await store.enablePersistence(SAMPLE_CREDENTIAL);

    expect(webauthn.getPrfOutputCallCount()).toBe(1); // フォールバックとして1回だけ呼ばれる
    expect(getSessionCredential()).toEqual(SAMPLE_CREDENTIAL);
  });

  it('tryRestore returns false when nothing was ever saved', async () => {
    const repo = createKeyStoreRepository(db);
    const store = createApiKeyStore(repo, createFakeWebAuthnClient());

    expect(await store.tryRestore()).toBe(false);
    expect(getSessionCredential()).toBeNull();
  });

  it('enablePersistence throws when PRF is not supported (e.g. Firefox)', async () => {
    const repo = createKeyStoreRepository(db);
    const store = createApiKeyStore(repo, createFakeWebAuthnClient({ prfSupported: false }));

    await expect(store.enablePersistence(SAMPLE_CREDENTIAL)).rejects.toThrow();
  });

  it('enablePersistence throws when WebAuthn itself is unavailable', async () => {
    const repo = createKeyStoreRepository(db);
    const store = createApiKeyStore(repo, createFakeWebAuthnClient({ available: false }));

    await expect(store.enablePersistence(SAMPLE_CREDENTIAL)).rejects.toThrow();
  });

  it('disablePersistence clears the stored credential so tryRestore stops working', async () => {
    const repo = createKeyStoreRepository(db);
    const webauthn = createFakeWebAuthnClient();
    const store = createApiKeyStore(repo, webauthn);

    await store.enablePersistence(SAMPLE_CREDENTIAL);
    await store.disablePersistence();
    clearSessionCredential();

    expect(await store.tryRestore()).toBe(false);
  });

  it('preserves provider and model through the persist/restore round trip for a non-default provider', async () => {
    const repo = createKeyStoreRepository(db);
    const store = createApiKeyStore(repo, createFakeWebAuthnClient());
    const credential: AiCredential = { provider: 'openai', apiKey: 'sk-openai-xyz', model: 'gpt-4o' };

    await store.enablePersistence(credential);
    clearSessionCredential();
    await store.tryRestore();

    expect(getSessionCredential()).toEqual(credential);
  });

  it('hasPersistedCredential reflects whether a credential has been saved, without needing WebAuthn', async () => {
    const repo = createKeyStoreRepository(db);
    const store = createApiKeyStore(repo, createFakeWebAuthnClient());

    expect(await store.hasPersistedCredential()).toBe(false);

    await store.enablePersistence(SAMPLE_CREDENTIAL);
    expect(await store.hasPersistedCredential()).toBe(true);

    await store.disablePersistence();
    expect(await store.hasPersistedCredential()).toBe(false);
  });
});
