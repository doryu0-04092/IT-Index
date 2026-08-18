import { useState } from 'react';
import type { ItIndexDB } from '../db';
import { resetAllData } from '../lib/factoryReset';
import ThemeSwitcher from '../lib/ThemeSwitcher';
import type { ThemeChoice } from '../lib/theme';
import { brandLabel } from '../lib/cardValidation';
import { getStoredLicenseCode, getStoredPaymentMethod } from '../lib/paymentStore';
import { activateLicense, ApiRequestError } from '../sync/apiClient';
import {
  clearServerBaseUrl,
  getServerBaseUrl,
  setServerBaseUrl,
  testServerConnection,
  validateServerUrl,
} from '../sync/serverConfig';
import { useAuthState, type AuthState } from '../sync/useAuthState';
import ApiKeySection from './ApiKeySection';

export interface SettingsScreenProps {
  db: ItIndexDB;
  themeChoice: ThemeChoice;
  onThemeChange: (choice: ThemeChoice) => void;
  /** 未ログイン時のライセンス誘導・APIキー設定の誘導から同期タブへ移動する */
  onGoToSync: () => void;
  /** ライセンス欄からチェックアウト画面へ移動する('purchase'=購入、'change-card'=カード変更) */
  onGoToCheckout: (intent: 'purchase' | 'change-card') => void;
}

/**
 * 設定タブ(要件定義書§4「提供形態」・§8「決済のモック化」「接続先サーバー設定UI」)。
 * ライセンス購入モックUI・APIキー設定(BYOK)・接続先サーバー設定・表示(テーマ)・データ初期化を
 * 1画面に集約する。同期タブ(SyncScreen.tsx)はアカウント・同期実行・競合解決・v1取り込みの
 * みに純化し、APIキー設定(ApiKeySection)とテーマ(ThemeSwitcher)はここへ移設した。
 *
 * ライセンスを主導線として最上部に置く(依頼者指定)。認証状態はuseAuthStateで自前に確認する
 * (SyncScreenと同じhookを使うが、インスタンスは別——sync/useAuthState.tsのコメント参照)。
 */
export default function SettingsScreen({
  db,
  themeChoice,
  onThemeChange,
  onGoToSync,
  onGoToCheckout,
}: SettingsScreenProps) {
  const { auth, setLicensed } = useAuthState();

  return (
    <section className="settings-screen">
      <LicenseSection
        auth={auth}
        onGoToSync={onGoToSync}
        onGoToCheckout={onGoToCheckout}
        onLicensedChange={setLicensed}
      />

      <section className="settings-section">
        <h2>APIキー設定</h2>
        {auth.status === 'authed' ? (
          <ApiKeySection token={auth.token} />
        ) : (
          <p className="status-text">
            APIキー設定にはログインが必要です。
            <button type="button" className="btn-text" onClick={onGoToSync}>
              同期タブへ
            </button>
          </p>
        )}
      </section>

      <ServerSection />

      <section className="settings-section">
        <h2>表示</h2>
        <ThemeSwitcher choice={themeChoice} onChange={onThemeChange} />
      </section>

      <DataSection db={db} />
    </section>
  );
}

/**
 * ライセンス(主導線)。要件定義書§4.2「決済はモック」。未ライセンス時は商品カード+
 * 「コードをお持ちの方」の2つの入口を並べる。決済(カード入力→処理→完了)は
 * チェックアウト画面(CheckoutScreen.tsx)が担い、ここは「購入手続きへ」の遷移だけを持つ。
 * 購入後は、チェックアウトが端末内に保存したライセンスコードとお支払い方法
 * (lib/paymentStore.ts)をこの欄に表示し、「カードを変更する」導線も置く(本人指定
 * 「ライセンスコードとカード変更は設定画面に出す」)。ライセンス有効の判定自体は
 * サーバー(/api/auth/me)が正で、チェックアウトから戻った際の再マウントで再取得される。
 */
function LicenseSection({
  auth,
  onGoToSync,
  onGoToCheckout,
  onLicensedChange,
}: {
  auth: AuthState;
  onGoToSync: () => void;
  onGoToCheckout: (intent: 'purchase' | 'change-card') => void;
  onLicensedChange: (licensed: boolean) => void;
}) {
  const [codeDraft, setCodeDraft] = useState('');
  const [activateBusy, setActivateBusy] = useState(false);
  const [activateError, setActivateError] = useState<string | null>(null);

  async function handleActivate() {
    const code = codeDraft.trim();
    if (auth.status !== 'authed' || code === '' || activateBusy) return;
    setActivateBusy(true);
    setActivateError(null);
    try {
      await activateLicense(auth.token, code);
      onLicensedChange(true);
      setCodeDraft('');
    } catch (err) {
      setActivateError(err instanceof ApiRequestError ? err.message : 'サーバーに接続できませんでした');
    } finally {
      setActivateBusy(false);
    }
  }

  if (auth.status === 'checking') {
    return (
      <section className="settings-section">
        <h2>ライセンス</h2>
        <p className="status-text">確認しています…</p>
      </section>
    );
  }

  if (auth.status === 'anonymous') {
    return (
      <section className="settings-section">
        <h2>ライセンス</h2>
        <p className="status-text">ライセンスの購入にはログインが必要です。</p>
        <button type="button" className="btn-primary" onClick={onGoToSync}>
          同期タブへ
        </button>
      </section>
    );
  }

  // 端末内保存の表示情報(lib/paymentStore.ts)。チェックアウトから戻ると<main>のkey切替で
  // この画面ごと再マウントされるため、レンダー時の同期読みで最新が反映される
  const storedCode = getStoredLicenseCode();
  const paymentMethod = getStoredPaymentMethod();

  return (
    <section className="settings-section">
      <h2>ライセンス</h2>
      {auth.licensed ? (
        <>
          <p className="status-text">ライセンス有効</p>
          {storedCode !== null && (
            <p className="status-text">
              ライセンスコード:{' '}
              <code className="license-code" data-testid="license-code">
                {storedCode}
              </code>
            </p>
          )}
          <h3>お支払い方法</h3>
          {paymentMethod !== null ? (
            <p className="license-payment-method">
              {brandLabel(paymentMethod.brand) !== null && (
                <span className="payment-brand-pill">{brandLabel(paymentMethod.brand)}</span>
              )}
              <span>•••• {paymentMethod.last4}</span>
              <span className="status-text-small">有効期限 {paymentMethod.expiry}</span>
            </p>
          ) : (
            <p className="status-text-small">登録されているカードはありません(モック決済)</p>
          )}
          <button type="button" className="btn-secondary" onClick={() => onGoToCheckout('change-card')}>
            {paymentMethod !== null ? 'カードを変更する' : 'カードを登録する'}
          </button>
        </>
      ) : (
        <>
          <div className="license-product-card">
            <h3>IT-Index プレミアム 月額¥300</h3>
            <p className="status-text-small">モック決済です。実際の課金は発生しません</p>
            <button type="button" className="btn-primary" onClick={() => onGoToCheckout('purchase')}>
              購入手続きへ
            </button>
          </div>

          <div className="license-activate">
            <h3>コードをお持ちの方</h3>
            <label htmlFor="settings-license-code-input">ライセンスコード</label>
            <input
              id="settings-license-code-input"
              type="text"
              value={codeDraft}
              onChange={(e) => setCodeDraft(e.target.value)}
              disabled={activateBusy}
            />
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void handleActivate()}
              disabled={activateBusy || codeDraft.trim() === ''}
            >
              {activateBusy ? '有効化しています…' : '有効化する'}
            </button>
            {activateError && <p className="sync-error">{activateError}</p>}
          </div>
        </>
      )}
    </section>
  );
}

/**
 * 接続先サーバー(セルフホスト。要件定義書§8「接続先サーバー設定UI」)。
 * 保存はsync/serverConfig.tsのsetServerBaseUrlのみが行い、接続テスト成功時にしか呼ばない
 * (失敗したURLを基底に据えて全リクエストを壊さないため)。
 */
function ServerSection() {
  const [savedBase, setSavedBase] = useState<string | null>(() => getServerBaseUrl());
  const [draft, setDraft] = useState(() => getServerBaseUrl() ?? '');
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleTest() {
    if (testing) return;
    setTesting(true);
    setMessage(null);
    setError(null);
    const validation = validateServerUrl(draft);
    if (!validation.ok) {
      setError(validation.error);
      setTesting(false);
      return;
    }
    const result = await testServerConnection(validation.normalized);
    if (result.ok) {
      setServerBaseUrl(validation.normalized);
      setSavedBase(validation.normalized);
      setMessage('接続できました。この接続先を保存しました。');
    } else {
      setError(result.error);
    }
    setTesting(false);
  }

  function handleResetDefault() {
    clearServerBaseUrl();
    setSavedBase(null);
    setDraft('');
    setMessage('公式サーバー(同一オリジン)に戻しました。');
    setError(null);
  }

  return (
    <section className="settings-section">
      <h2>接続先サーバー</h2>
      <p className="status-text">
        自分のCloudflareに立てたサーバーへ接続できます(手順はリポジトリのdocs/v2/deploy.md)。
      </p>
      <p className="status-text" data-testid="server-base-status">
        現在の接続先: {savedBase ?? '公式(同一オリジン)'}
      </p>

      <label htmlFor="settings-server-url-input">サーバーURL</label>
      <input
        id="settings-server-url-input"
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="https://example.workers.dev"
        disabled={testing}
      />

      <div className="sync-api-key-actions">
        {/* APIキー設定セクション(ApiKeySection.tsx)にも同名の「接続テスト」ボタンがある
            (ログイン済みでは両方が同時に表示される)ため、ここは区別できる文言にする */}
        <button
          type="button"
          className="btn-primary"
          onClick={() => void handleTest()}
          disabled={testing || draft.trim() === ''}
        >
          {testing ? 'サーバー接続を確認しています…' : 'サーバー接続テスト'}
        </button>
        <button type="button" className="btn-danger" onClick={handleResetDefault} disabled={testing || savedBase === null}>
          既定に戻す
        </button>
      </div>
      {message && <p className="status-text">{message}</p>}
      {error && <p className="sync-error">{error}</p>}
    </section>
  );
}

const CONFIRM_TEXT = '初期化する';

/**
 * データ(オールクリア。v1のFactoryResetSectionを移植。lib/factoryReset.ts参照)。
 * 通常のconfirm()一発では誤操作を防げないため、確認文字列の入力が完全一致した時だけ実行できる
 * ようにする(取り消せない広範囲の操作のため)。
 */
function DataSection({ db }: { db: ItIndexDB }) {
  const [expanded, setExpanded] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleCancel() {
    setExpanded(false);
    setConfirmText('');
    setError(null);
  }

  async function handleExecute() {
    if (confirmText !== CONFIRM_TEXT || busy) return;
    setBusy(true);
    setError(null);
    try {
      await resetAllData(db);
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <section className="settings-section settings-section-danger">
      <h2>データ</h2>
      <p className="status-text">
        用語・ノート・検索履歴・APIキー・テーマ設定など、このアプリが保存している全てのデータを削除し、
        初回起動時と同じ状態に戻します。<strong>この操作は取り消せません。</strong>
      </p>
      {!expanded ? (
        <button type="button" className="btn-danger" onClick={() => setExpanded(true)}>
          オールクリアする
        </button>
      ) : (
        <div className="factory-reset-confirm">
          <p className="status-text">実行するには下の欄に「{CONFIRM_TEXT}」と入力してください。</p>
          <label htmlFor="settings-factory-reset-confirm">確認文字列</label>
          <input
            id="settings-factory-reset-confirm"
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={CONFIRM_TEXT}
            disabled={busy}
          />
          <div className="sync-api-key-actions">
            <button
              type="button"
              className="btn-primary"
              onClick={() => void handleExecute()}
              disabled={confirmText !== CONFIRM_TEXT || busy}
            >
              {busy ? '実行中…' : '実行する'}
            </button>
            <button type="button" className="btn-text" onClick={handleCancel} disabled={busy}>
              キャンセル
            </button>
          </div>
          {error && <p className="sync-error">初期化に失敗しました: {error}</p>}
        </div>
      )}
    </section>
  );
}
