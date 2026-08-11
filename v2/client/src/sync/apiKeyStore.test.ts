import { beforeEach, describe, expect, it } from 'vitest';
import { clearApiKey, getApiKey, maskApiKey, setApiKey } from './apiKeyStore';

const STORAGE_KEY = 'it-index-v2:openai-key';

describe('apiKeyStore', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('未設定ならnullを返す', () => {
    expect(getApiKey()).toBeNull();
  });

  it('保存したキーを読み出せる(キー名は固定)', () => {
    setApiKey('sk-test-1234567890');
    expect(getApiKey()).toBe('sk-test-1234567890');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('sk-test-1234567890');
  });

  it('前後の空白は落として保存する', () => {
    setApiKey('  sk-test-1234567890\n');
    expect(getApiKey()).toBe('sk-test-1234567890');
  });

  it('空文字・空白のみの保存は削除と同じ扱い', () => {
    setApiKey('sk-test-1234567890');
    setApiKey('   ');
    expect(getApiKey()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('保存済みの値が空白のみだった場合も未設定として読む', () => {
    localStorage.setItem(STORAGE_KEY, '  ');
    expect(getApiKey()).toBeNull();
  });

  it('clearApiKeyで削除できる', () => {
    setApiKey('sk-test-1234567890');
    clearApiKey();
    expect(getApiKey()).toBeNull();
  });

  it('maskApiKeyはキー全体を返さない(先頭数文字だけ)', () => {
    const key = 'sk-test-1234567890';
    const masked = maskApiKey(key);
    expect(masked).toBe('sk-tes…');
    expect(masked).not.toContain('1234567890');
  });
});
