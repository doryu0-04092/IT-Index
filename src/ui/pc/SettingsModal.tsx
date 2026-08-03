import { useEffect, useState } from 'react';
import { getProviderInfo } from '../../ai/providers/types';
import type { AutoUpdateExistingTermsMode } from '../../ai/distribution';
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
  /** 要件定義書§5.3「既存語の自動更新」。現在の設定値 */
  autoUpdateExistingTerms: AutoUpdateExistingTermsMode;
  onChangeAutoUpdateExistingTerms: (mode: AutoUpdateExistingTermsMode) => void;
}

/**
 * 歯車アイコンから開く設定モーダル。APIキー（プロバイダ・モデルの変更含む）と、
 * この端末への保存（パスキー）をここに集約する（2026-07-28設計）。
 * 既存語の自動更新範囲（2026-07-30追加）もここに置く——承認画面を廃止した代わりに、
 * 利用者が事前に選べる唯一のコントロールになる。
 */
export default function SettingsModal({
  apiKeyStore,
  onClose,
  onCredentialReady,
  autoUpdateExistingTerms,
  onChangeAutoUpdateExistingTerms,
}: SettingsModalProps) {
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
        setAuthError('認証できませんでした（キャンセルされたか、この端末のパスキーではありません）。');
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
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal-content" onClick={(e) => e.stopPropagation()}>
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
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>設定</h2>
          <button type="button" className="dismiss-error" onClick={onClose}>
            ✕
          </button>
        </div>

        <section className="settings-section">
          <h3>AIプロバイダ・APIキー</h3>
          <p className="search-status">
            {credential ? `${getProviderInfo(credential.provider).label}（${credential.model}）を使用中` : '未設定'}
          </p>
          <button type="button" className="btn-secondary" onClick={() => setEditingKey(true)}>
            {credential ? 'APIキーを変更' : 'APIキーを設定'}
          </button>
        </section>

        <section className="settings-section">
          <h3>既存語の自動更新</h3>
          <p className="search-status">
            AIチャットの確定は承認画面を挟まず自動でAI補足に反映されます。この設定は、話題にしていない語（会話の中でついでに触れられただけの既存語）まで反映するかどうかを決めます。
          </p>
          <label className="settings-radio">
            <input
              type="radio"
              name="autoUpdateExistingTerms"
              checked={autoUpdateExistingTerms === 'askedOnly'}
              onChange={() => onChangeAutoUpdateExistingTerms('askedOnly')}
            />
            自分が検索・質問した語だけ自動更新する（既定）
          </label>
          <label className="settings-radio">
            <input
              type="radio"
              name="autoUpdateExistingTerms"
              checked={autoUpdateExistingTerms === 'all'}
              onChange={() => onChangeAutoUpdateExistingTerms('all')}
            />
            他の語について調べた際に出てきた情報も自動更新する
          </label>
        </section>

        {hasPersisted && (
          <section className="settings-section">
            <h3>この端末への保存</h3>
            <p className="search-status">パスキーで暗号化保存されています。</p>
            <div className="api-key-actions">
              <button type="button" className="btn-secondary" onClick={handleAuthenticate} disabled={authenticating || credential !== null}>
                {authenticating ? '認証中…' : credential ? '認証済み' : 'パスキーで認証'}
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
    </div>
  );
}
