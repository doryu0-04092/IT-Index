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
 * 設定（Android版）。propsとロジックはPC版と同じ。以前は下から出るシート
 * （`Sheet.tsx`）で見せていたが、トップナビ（ドロワー）からの遷移先という点で他の
 * 画面（検索・履歴・単語一覧）と変わらないのにここだけモーダルなのは違和感がある
 * というユーザー指摘により、PC版と同じ通常の画面表示に変更した
 * （`src/ui/pc/SettingsModal.tsx` と同じ扱い）。
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
          <p className="search-status">この端末のセキュアな保存領域(Android Keystore)に暗号化保存されています。</p>
          <div className="api-key-actions">
            <button type="button" className="btn-secondary" onClick={handleAuthenticate} disabled={authenticating || credential !== null}>
              {authenticating ? '認証中…' : credential ? '認証済み' : '認証して復元'}
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
