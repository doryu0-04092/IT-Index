import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAiCredential,
  getAiCredential,
  getVerifiedCredential,
  markCredentialUnverified,
  maskApiKey,
  providerLabel,
  saveVerifiedCredential,
} from './apiKeyStore';

const STORAGE_KEY = 'it-index-v2:ai-credential';
const LEGACY_KEY = 'it-index-v2:openai-key';

describe('apiKeyStore', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('未設定ならnullを返す', () => {
    expect(getAiCredential()).toBeNull();
    expect(getVerifiedCredential()).toBeNull();
  });

  it('保存した資格情報を読み出せる(キー名は固定・検証済みで保存される)', () => {
    saveVerifiedCredential({ key: 'sk-test-1234567890', provider: 'openai', model: 'gpt-4.1-mini' });

    expect(getAiCredential()).toEqual({
      key: 'sk-test-1234567890',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      verified: true,
    });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null').provider).toBe('openai');
  });

  it('プロバイダとモデル名を保存・復元できる(モデル未指定はundefined)', () => {
    saveVerifiedCredential({ key: 'sk-ant-key', provider: 'anthropic' });

    const credential = getAiCredential();
    expect(credential?.provider).toBe('anthropic');
    expect(credential?.model).toBeUndefined();
  });

  it('前後の空白は落として保存する(モデル名も同様)', () => {
    saveVerifiedCredential({ key: '  sk-test-1234567890\n', provider: 'openai', model: '  gpt-4.1  ' });

    expect(getAiCredential()?.key).toBe('sk-test-1234567890');
    expect(getAiCredential()?.model).toBe('gpt-4.1');
  });

  it('空文字・空白のみのキーの保存は削除と同じ扱い', () => {
    saveVerifiedCredential({ key: 'sk-test-1234567890', provider: 'openai' });
    saveVerifiedCredential({ key: '   ', provider: 'openai' });

    expect(getAiCredential()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('壊れた値・プロバイダ不正の値は未設定として読む', () => {
    localStorage.setItem(STORAGE_KEY, 'not json');
    expect(getAiCredential()).toBeNull();

    localStorage.setItem(STORAGE_KEY, JSON.stringify({ key: 'sk-x', provider: 'gemini', verified: true }));
    expect(getAiCredential()).toBeNull();
  });

  it('markCredentialUnverifiedで検証済みフラグだけを外す(キーは残す)', () => {
    saveVerifiedCredential({ key: 'sk-test-1234567890', provider: 'openai' });
    markCredentialUnverified();

    expect(getAiCredential()?.key).toBe('sk-test-1234567890');
    expect(getAiCredential()?.verified).toBe(false);
    // 未検証の資格情報はチャットに使わない
    expect(getVerifiedCredential()).toBeNull();
  });

  it('clearAiCredentialで削除できる(旧キーも消す)', () => {
    saveVerifiedCredential({ key: 'sk-test-1234567890', provider: 'openai' });
    localStorage.setItem(LEGACY_KEY, 'sk-legacy');

    clearAiCredential();

    expect(getAiCredential()).toBeNull();
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it('maskApiKeyはキー全体を返さない(先頭数文字だけ)', () => {
    const key = 'sk-test-1234567890';
    const masked = maskApiKey(key);
    expect(masked).toBe('sk-tes…');
    expect(masked).not.toContain('1234567890');
  });

  it('providerLabelは表示名を返す', () => {
    expect(providerLabel('openai')).toBe('OpenAI');
    expect(providerLabel('anthropic')).toBe('Anthropic');
  });

  // PR #87の保存形式(OpenAIキー1本)からの移行。
  describe('旧キーからの移行', () => {
    it('旧キーだけがある場合はOpenAI・検証済みとして移行し、旧キーを削除する', () => {
      localStorage.setItem(LEGACY_KEY, 'sk-legacy-1234567890');

      const credential = getAiCredential();

      expect(credential).toEqual({
        key: 'sk-legacy-1234567890',
        provider: 'openai',
        model: undefined,
        verified: true,
      });
      expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
      // 移行結果は新キーに永続化されている(次回の読み出しでも同じ)
      expect(getAiCredential()?.key).toBe('sk-legacy-1234567890');
      // 検証済み扱いなのでチャットにそのまま使える(移行で共有キー経路へ戻さない)
      expect(getVerifiedCredential()?.key).toBe('sk-legacy-1234567890');
    });

    it('旧キーが空白のみなら移行せず未設定として扱う', () => {
      localStorage.setItem(LEGACY_KEY, '  ');

      expect(getAiCredential()).toBeNull();
      expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    });

    it('新形式が既にある場合は旧キーを無視して削除する', () => {
      saveVerifiedCredential({ key: 'sk-new-key', provider: 'anthropic' });
      localStorage.setItem(LEGACY_KEY, 'sk-legacy-1234567890');

      const credential = getAiCredential();

      expect(credential?.key).toBe('sk-new-key');
      expect(credential?.provider).toBe('anthropic');
      expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    });
  });
});
