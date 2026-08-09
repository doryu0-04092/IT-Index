import { useState } from 'react';
import { listModelsForProvider } from '../../ai/providers';
import type { AiProvider } from '../../ai/providers/types';
import { getProviderInfo, PROVIDERS } from '../../ai/providers/types';
import { logAiError } from '../../ai/logError';
import type { ApiKeyStore } from '../../keystore/apiKeyStore';
import { setSessionCredential } from '../../keystore/apiKeyStore';

export interface ApiKeyPromptProps {
  apiKeyStore: ApiKeyStore;
  onSet: () => void;
  onBack: () => void;
  /** チャット画面からのフルスクリーン遷移では「← 検索に戻る」、設定モーダルでは「キャンセル」等 */
  backLabel?: string;
}

type Step =
  | { name: 'enterKey' }
  | { name: 'chooseModel'; models: string[] };

/**
 * APIキー入力。2段階にしてある（2026-07-27設計）:
 * ① プロバイダ・APIキーを入力し「接続を確認」→ そのプロバイダのモデル一覧APIを叩く。
 *    この呼び出し自体がAPIキーの疎通確認を兼ねる（無効ならここでエラーが分かる）。
 * ② 取得できたモデル一覧をプルダウンで選ばせる（自由入力にすると誤ったモデル名を
 *    打ち込んでしまえるため）。一覧が取れない場合のみテキスト入力にフォールバックする。
 *
 * 既定はセッションのみ保持（要件定義書§5.6層3）。「この端末に保存する」を明示的に
 * チェックした場合のみ、OS標準の暗号化機能（Electron safeStorage）で暗号化保存する（層2）。
 */
export default function ApiKeyPrompt({ apiKeyStore, onSet, onBack, backLabel = '← 検索に戻る' }: ApiKeyPromptProps) {
  const [provider, setProvider] = useState<AiProvider>('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [step, setStep] = useState<Step>({ name: 'enterKey' });
  const [selectedModel, setSelectedModel] = useState('');
  const [manualModel, setManualModel] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [persist, setPersist] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const canPersist = apiKeyStore.isPersistenceAvailable();

  function handleProviderChange(next: AiProvider) {
    setProvider(next);
    setStep({ name: 'enterKey' });
    setConnectError(null);
  }

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    const key = apiKey.trim();
    if (key === '') return;

    setConnecting(true);
    setConnectError(null);
    try {
      const models = await listModelsForProvider(provider, key);
      setStep({ name: 'chooseModel', models });
      setSelectedModel(models[0] ?? '');
      setManualModel(getProviderInfo(provider).defaultModel);
    } catch (err) {
      logAiError('ApiKeyPrompt.handleConnect', err);
      setConnectError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (step.name !== 'chooseModel') return;

    const model = (step.models.length > 0 ? selectedModel : manualModel).trim();
    if (model === '') return;

    const credential = { provider, apiKey: apiKey.trim(), model };
    setSaveError(null);

    if (persist) {
      setSaving(true);
      try {
        await apiKeyStore.enablePersistence(credential);
        setSaving(false);
        onSet();
        return;
      } catch (err) {
        // 保存には失敗したが、入力されたキー自体は有効なのでセッションでは使えるようにする
        logAiError('ApiKeyPrompt.handleSubmit(enablePersistence)', err);
        setSessionCredential(credential);
        setSaveError(
          `この端末への保存はできませんでした（${err instanceof Error ? err.message : String(err)}）。今回はこのセッションのみで使用します。`,
        );
        setSaving(false);
        onSet();
        return;
      }
    }

    setSessionCredential(credential);
    onSet();
  }

  return (
    <div className="api-key-prompt">
      <button type="button" className="term-detail-back" onClick={onBack}>
        {backLabel}
      </button>
      <p>AIを使うにはAPIキーが必要です。</p>

      {step.name === 'enterKey' ? (
        <form onSubmit={handleConnect}>
          <label className="api-key-field">
            <span>プロバイダ</span>
            <select value={provider} onChange={(e) => handleProviderChange(e.target.value as AiProvider)}>
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          <label className="api-key-field">
            <span>APIキー</span>
            <input
              type="password"
              placeholder={getProviderInfo(provider).apiKeyPlaceholder}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              // この画面はキー入力そのものが目的で開かれるダイアログのため、
              // 開いた時点で入力欄へフォーカスを移すのが自然な動線。
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
            />
          </label>

          <button type="submit" className="btn-primary" disabled={connecting || apiKey.trim() === ''}>
            {connecting ? '接続を確認中…' : '接続を確認'}
          </button>
          {connectError && <p className="chat-error">{connectError}</p>}
        </form>
      ) : (
        <form onSubmit={handleSubmit}>
          <p className="search-status">接続を確認できました。使うモデルを選んでください。</p>

          {step.models.length > 0 ? (
            <label className="api-key-field">
              <span>モデル</span>
              <select value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)}>
                {step.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="api-key-field">
              <span>モデル名（一覧を取得できなかったため直接入力）</span>
              <input
                type="text"
                placeholder={getProviderInfo(provider).defaultModel}
                value={manualModel}
                onChange={(e) => setManualModel(e.target.value)}
              />
            </label>
          )}

          {canPersist ? (
            <label className="api-key-persist">
              <input type="checkbox" checked={persist} onChange={(e) => setPersist(e.target.checked)} />
              この端末に保存する（暗号化して保存。次回から入力不要）
            </label>
          ) : (
            <p className="search-status">この環境では保存機能が使えないため、毎回入力が必要です。</p>
          )}

          <div className="api-key-actions">
            <button type="button" className="btn-secondary" onClick={() => setStep({ name: 'enterKey' })} disabled={saving}>
              APIキーを入力し直す
            </button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? '保存中…' : '設定'}
            </button>
          </div>
          {saveError && <p className="chat-error">{saveError}</p>}
        </form>
      )}
    </div>
  );
}
