import { useEffect, useState } from 'react';
import { getProviderInfo } from '../../ai/providers/types';
import type { AutoUpdateExistingTermsMode } from '../../ai/distribution';
import { logAiError } from '../../ai/logError';
import type { ApiKeyStore } from '../../keystore/apiKeyStore';
import { getSessionCredential } from '../../keystore/apiKeyStore';
import ApiKeyPrompt from './ApiKeyPrompt';
import FactoryResetSection from './FactoryResetSection';
import Sheet from './Sheet';

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
 * 設定（Android版）。propsとロジックはPC版と同じだが、見せ方は下から出るシート
 * （`Sheet.tsx`）にしてある。縦持ちでは中央のダイアログだと閉じる操作も内容も
 * 親指から遠くなるため。
 *
 * ローカルフォルダ連携（File System Access API、`LocalFolderPanel`）はPC専用機能のため
 * ここには置かない——Androidでは常に`isFolderSyncAvailable()`がfalseになり
 * 「この環境では使えません」の案内しか出せず、設定項目として意味を持たないため
 * （データをAndroidからPCへ渡す導線は「連携」のQR/ファイルで別途提供している）。
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
      <Sheet title="APIキーの設定" onClose={onClose}>
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
      </Sheet>
    );
  }

  return (
    <Sheet title="設定" onClose={onClose}>
      <>
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
      </>
    </Sheet>
  );
}
