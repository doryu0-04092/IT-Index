import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAiCredential,
  getAiCredential,
  getVerifiedCredential,
  markCredentialUnverified,
  maskApiKey,
  pickDefaultModel,
  providerLabel,
  saveVerifiedCredential,
  updateCredentialModel,
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

  // モデル一覧(接続テスト=POST /api/ai/modelsの取得結果)の保存と、そこからの選び直し。
  describe('モデル一覧', () => {
    it('取得した一覧を保存・復元できる', () => {
      saveVerifiedCredential({
        key: 'sk-test-1234567890',
        provider: 'openai',
        model: 'gpt-5.6-luna',
        models: ['gpt-4.1-mini', 'gpt-5.6-luna'],
      });

      expect(getAiCredential()?.models).toEqual(['gpt-4.1-mini', 'gpt-5.6-luna']);
    });

    it('一覧が0件・不正な要素だけの場合はundefined(未取得と同じ扱い)', () => {
      saveVerifiedCredential({ key: 'sk-test-1234567890', provider: 'openai', models: [] });
      expect(getAiCredential()?.models).toBeUndefined();

      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ key: 'sk-x', provider: 'openai', models: [1, '', null], verified: true }),
      );
      expect(getAiCredential()?.models).toBeUndefined();
    });

    it('models無しの旧保存データも壊さず読める(後方互換)', () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ key: 'sk-old-1234567890', provider: 'anthropic', model: 'claude-x', verified: true }),
      );

      const credential = getAiCredential();
      expect(credential?.key).toBe('sk-old-1234567890');
      expect(credential?.model).toBe('claude-x');
      expect(credential?.models).toBeUndefined();
      // 検証済みの扱いは変わらない(チャットにそのまま使える)
      expect(getVerifiedCredential()?.model).toBe('claude-x');
    });

    it('updateCredentialModelはモデルだけを差し替える(キー・一覧・検証済みは維持)', () => {
      saveVerifiedCredential({
        key: 'sk-test-1234567890',
        provider: 'openai',
        model: 'gpt-5.6-luna',
        models: ['gpt-4.1-mini', 'gpt-5.6-luna'],
      });

      const updated = updateCredentialModel('gpt-4.1-mini');

      expect(updated?.model).toBe('gpt-4.1-mini');
      // 即時に永続化されている(画面のstateだけの変更ではない)
      expect(getAiCredential()).toEqual({
        key: 'sk-test-1234567890',
        provider: 'openai',
        model: 'gpt-4.1-mini',
        models: ['gpt-4.1-mini', 'gpt-5.6-luna'],
        verified: true,
      });
    });

    it('updateCredentialModelの空文字はundefined(サーバー側の既定モデル)にする', () => {
      saveVerifiedCredential({ key: 'sk-test-1234567890', provider: 'openai', model: 'gpt-4.1-mini' });

      expect(updateCredentialModel('  ')?.model).toBeUndefined();
      expect(getAiCredential()?.key).toBe('sk-test-1234567890');
    });

    it('updateCredentialModelは資格情報が無ければ何もしない(キーを作らない)', () => {
      expect(updateCredentialModel('gpt-4.1-mini')).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });
  });

  describe('pickDefaultModel', () => {
    it('OpenAIはgpt-5.6-lunaがあればそれを選ぶ', () => {
      expect(pickDefaultModel('openai', ['chatgpt-4o-latest', 'gpt-5.6-luna', 'o3-mini'])).toBe('gpt-5.6-luna');
    });

    it('OpenAIでgpt-5.6-lunaが無ければ先頭', () => {
      expect(pickDefaultModel('openai', ['gpt-4.1-mini', 'o3-mini'])).toBe('gpt-4.1-mini');
    });

    it('AnthropicはHaiku系を優先し、一覧の並び(新しい順)で最初のものを選ぶ', () => {
      expect(
        pickDefaultModel('anthropic', ['claude-sonnet-5', 'claude-haiku-5', 'claude-3-5-haiku-latest']),
      ).toBe('claude-haiku-5');
    });

    it('AnthropicでHaiku系が無ければ先頭', () => {
      expect(pickDefaultModel('anthropic', ['claude-sonnet-5', 'claude-opus-4-1'])).toBe('claude-sonnet-5');
    });

    it('一覧が空ならundefined(モデル名の直接入力へフォールバックする)', () => {
      expect(pickDefaultModel('openai', [])).toBeUndefined();
      expect(pickDefaultModel('anthropic', [])).toBeUndefined();
    });
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
