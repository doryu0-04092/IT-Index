import { useEffect, useState } from 'react';
import { getProviderInfo } from '../../ai/providers/types';
import { logAiError } from '../../ai/logError';
import type { ApiKeyStore } from '../../keystore/apiKeyStore';
import { getSessionCredential } from '../../keystore/apiKeyStore';
import ApiKeyPrompt from './ApiKeyPrompt';
import FactoryResetSection from './FactoryResetSection';

export interface SettingsModalProps {
  apiKeyStore: ApiKeyStore;
  onClose: () => void;
  /** APIキーが（再）設定された、または保存済み資格情報を復元できたときに呼ぶ */
  onCredentialReady: () => void;
}

/**
 * トップナビ「設定」の画面。APIキー（プロバイダ・モデルの変更含む）と、この端末への保存
 * （OS標準の暗号化機能）をここに集約する（2026-07-28設計）。
 * 以前はモーダル表示だったが、他のナビ項目（検索・履歴・単語一覧）と同じ画面遷移先なのに
 * ここだけモーダルなのは違和感があるというユーザー指摘により、通常の画面表示に変更した。
 * `onClose` という名前のまま残しているが、実質は「検索へ戻る」（App.tsx側でその遷移をする）。
 */
export default function SettingsModal({ apiKeyStore, onClose, onCredentialReady }: SettingsModalProps) {
  const [editingKey, setEditingKey] = useState(false);
  const [hasPersisted, setHasPersisted] = useState(false);
  const [authenticating, setAuthenticating] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const credential = getSessionCredential();

  useEffect(() => {
    apiKeyStore.hasPersistedCredential().then(setHasPersisted);
  }, [apiKeyStore]);

  async function handleAuthenticate() {
    setAuthenticating(true);
    setAuthError(null);
    try {
      const restored = await apiKeyStore.tryRestore();
      if (restored) {
        onCredentialReady();
      } else {
        setAuthError('復元できませんでした（キャンセルされたか、保存内容が壊れている可能性があります）。');
      }
    } catch (err) {
      logAiError('SettingsModal.handleAuthenticate', err);
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthenticating(false);
    }
  }

  async function handleForget() {
    await apiKeyStore.disablePersistence();
    setHasPersisted(false);
  }

  if (editingKey) {
    return (
      <div className="settings-screen">
        <ApiKeyPrompt
          apiKeyStore={apiKeyStore}
          backLabel="← 設定に戻る"
          onBack={() => setEditingKey(false)}
          onSet={() => {
            setEditingKey(false);
            onCredentialReady();
            apiKeyStore.hasPersistedCredential().then(setHasPersisted);
          }}
        />
      </div>
    );
  }

  return (
    <div className="settings-screen">
      <button type="button" className="term-detail-back" onClick={onClose}>
        ← 検索に戻る
      </button>

      <section className="settings-section">
        <h3>AIプロバイダ・APIキー</h3>
        <p className="search-status">
          {credential ? `${getProviderInfo(credential.provider).label}（${credential.model}）を使用中` : '未設定'}
        </p>
        <button type="button" className="btn-secondary" onClick={() => setEditingKey(true)}>
          {credential ? 'APIキーを変更' : 'APIキーを設定'}
        </button>
      </section>

      {hasPersisted && (
        <section className="settings-section">
          <h3>この端末への保存</h3>
          <p className="search-status">OS標準の暗号化機能で保存されています。</p>
          <div className="api-key-actions">
            <button type="button" className="btn-secondary" onClick={handleAuthenticate} disabled={authenticating || credential !== null}>
              {authenticating ? '復元中…' : credential ? '復元済み' : '保存内容を復元'}
            </button>
            <button type="button" className="btn-text" onClick={handleForget}>
              この端末の保存を削除
            </button>
          </div>
          {authError && <p className="chat-error">{authError}</p>}
        </section>
      )}

      <FactoryResetSection />
    </div>
  );
}
