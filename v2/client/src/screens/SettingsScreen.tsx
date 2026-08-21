import { useState } from 'react';
import type { ItIndexDB } from '../db';
import { resetAllData } from '../lib/factoryReset';
import ThemeSwitcher from '../lib/ThemeSwitcher';
import type { ThemeChoice } from '../lib/theme';
import { brandLabel } from '../lib/cardValidation';
import { formatBillingDate, listBilledDates, nextBillingDate } from '../lib/billingCycle';
import LicenseHelpModal from '../lib/LicenseHelpModal';
import ServerHelpModal from '../lib/ServerHelpModal';
import {
  activateLicense,
  ApiRequestError,
  cancelLicense,
  type PaymentMethod,
} from '../sync/apiClient';
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
  const { auth, setLicensed, clearLicense } = useAuthState();

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

      {/* 解約は取り消せない操作のため最下部に置く(本人指定)。課金がある購入経路にだけ出す */}
      {auth.status === 'authed' && auth.licensed && auth.licenseSource === 'purchase' && (
        <CancelLicenseSection token={auth.token} onCanceled={clearLicense} />
      )}
    </section>
  );
}

/**
 * ライセンス(主導線)。要件定義書§4.2「決済はモック」。未ライセンス時は商品カード+
 * 「コードをお持ちの方」の2つの入口を並べる。決済(カード入力→処理→完了)は
 * チェックアウト画面(CheckoutScreen.tsx)が担い、ここは「購入手続きへ」の遷移だけを持つ。
 * 購入後はライセンスコード・お支払い方法・課金開始日/次回請求日をこの欄に表示し、
 * 「カードを変更する」導線も置く(本人指定「ライセンスコードとカード変更は設定画面に出す」)。
 *
 * **表示に使う値はすべて/api/auth/me由来**(auth経由)。以前はコードとカードを端末の
 * localStorageに持っていたが、ライセンスの有効/無効はアカウント単位のためズレが生じ、
 * 購入した端末以外で「ライセンス有効なのにカード未登録」という矛盾表示になっていた。
 * 保存先をサーバー1箇所に寄せたので、この欄はauthをそのまま映すだけでよい。
 * チェックアウトから戻った際は<main>のkey切替で再マウントされ、最新が再取得される。
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
  // 「何のための月額オプションか」のヘルプ(#151)。未ライセンス(購入検討中)と
  // ライセンス有効(何に支払っているかの確認)の両方から開けるよう見出し行に置く
  const [helpOpen, setHelpOpen] = useState(false);

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

  const { licenseCode, licenseSource, activatedAt, paymentMethod } = auth;
  // 運営者コードでの有効化には課金が無い。カード欄・請求日を出すと「登録されていない=不具合」と
  // 誤解されるため、この経路では課金まわりを一切表示しない
  const isPurchased = licenseSource === 'purchase';

  return (
    <section className="settings-section">
      <div className="settings-heading-row">
        <h2>ライセンス</h2>
        <button type="button" className="btn-text" onClick={() => setHelpOpen(true)}>
          このプランでできること
        </button>
      </div>
      {helpOpen && <LicenseHelpModal onClose={() => setHelpOpen(false)} />}
      {auth.licensed ? (
        <>
          <p className="status-text">ライセンス有効</p>
          {licenseCode !== null && (
            <p className="status-text">
              ライセンスコード:{' '}
              <code className="license-code" data-testid="license-code">
                {licenseCode}
              </code>
            </p>
          )}

          {!isPurchased ? (
            <p className="status-text-small">コードで有効化済み(カード登録なし)</p>
          ) : (
            <>
              <h3>お支払い方法</h3>
              {paymentMethod !== null ? (
                <>
                  <p className="license-payment-method">
                    {brandLabel(paymentMethod.brand) !== null && (
                      <span className="payment-brand-pill">{brandLabel(paymentMethod.brand)}</span>
                    )}
                    <span>•••• {paymentMethod.last4}</span>
                    <span className="status-text-small">有効期限 {paymentMethod.expiry}</span>
                  </p>
                  <p className="status-text-small">
                    このカードから毎月引き落とされます(モック決済のため実際の課金はありません)
                  </p>
                </>
              ) : (
                <p className="status-text-small">
                  お支払い方法を確認できませんでした。カードを登録してください。
                </p>
              )}
              {activatedAt !== null && <BillingSchedule activatedAt={activatedAt} />}
              {activatedAt !== null && (
                <BillingHistory
                  activatedAt={activatedAt}
                  licenseCode={licenseCode}
                  paymentMethod={paymentMethod}
                />
              )}
              <button
                type="button"
                className="btn-secondary"
                onClick={() => onGoToCheckout('change-card')}
              >
                {paymentMethod !== null ? 'カードを変更する' : 'カードを登録する'}
              </button>
            </>
          )}
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
 * 課金開始日と次回請求日(lib/billingCycle.tsの純関数で算出)。
 * 「今」はマウント時に一度だけ確定させる——レンダーのたびにDate.now()を読むと
 * 再レンダーで結果が変わりうる(react-hooks/purity)。日単位の表示なので初回の値で足りる。
 */
function BillingSchedule({ activatedAt }: { activatedAt: number }) {
  const [now] = useState(() => Date.now());
  const startedOn = formatBillingDate(new Date(activatedAt));
  const nextOn = formatBillingDate(nextBillingDate(activatedAt, now));
  return (
    <dl className="license-billing" data-testid="billing-schedule">
      <div>
        <dt>課金開始日</dt>
        <dd>{startedOn}</dd>
      </div>
      <div>
        <dt>次回請求日</dt>
        <dd>{nextOn}(¥300)</dd>
      </div>
    </dl>
  );
}

/** プレミアムの月額(表示用。金額の literal を履歴・領収・請求日で散らさないためここに置く) */
const MONTHLY_PRICE_LABEL = '¥300';

/**
 * 支払い履歴(#146)。課金開始日から今日までに到来済みの請求日を新しい順で並べ、
 * 各行を開くと1件分の明細(領収の表示)が出る。
 *
 * **サーバーに支払いの記録は無い。** 実課金が無いモック段階では入金イベント自体が
 * 存在しないため、履歴は `activatedAt` から `lib/billingCycle.ts` の純関数で算出する
 * (既に表示している「次回請求日」と同じ数え方・同じ関数を使う)。実課金を導入する時は、
 * この算出をサーバーの支払い記録の取得に差し替える——画面側の構造は変えずに済む。
 *
 * 解約済みのアカウントはここへ到達しない(`/api/auth/me` は有効なライセンスだけを返し、
 * 解約後は購入導線が表示されるため)。
 */
function BillingHistory({
  activatedAt,
  licenseCode,
  paymentMethod,
}: {
  activatedAt: number;
  licenseCode: string | null;
  paymentMethod: PaymentMethod | null;
}) {
  // BillingScheduleと同じ理由で「今」はマウント時に一度だけ確定させる(react-hooks/purity)
  const [now] = useState(() => Date.now());
  const billedDates = listBilledDates(activatedAt, now);
  if (billedDates.length === 0) return null;

  return (
    <div className="license-history" data-testid="payment-history">
      <h4>支払い履歴</h4>
      <ul className="license-history-list">
        {billedDates.map((date) => (
          <li key={date.getTime()}>
            <details>
              <summary>
                <span>{formatBillingDate(date)}</span>
                <span className="license-history-amount">{MONTHLY_PRICE_LABEL}</span>
              </summary>
              <PaymentReceipt date={date} licenseCode={licenseCode} paymentMethod={paymentMethod} />
            </details>
          </li>
        ))}
      </ul>
      <p className="status-text-small">
        モック決済のため、実際の請求・入金は発生していません。
      </p>
    </div>
  );
}

/**
 * 1件分の支払い明細(領収の表示)。**正式な領収書ではない**ことを明細そのものに書く——
 * 実際には入金が起きていないため、本物の領収書と見分けがつかない体裁にしてはいけない。
 * 発行者名・登録番号のような、正式な書類に見せる項目は意図的に持たない。
 *
 * 支払い方法は**現在登録されているカード**を出す。`payment_methods` は1アカウント1件の
 * 上書き保存で、その時点でどのカードだったかの記録が無いため(dtのラベルでその旨を示す)。
 */
function PaymentReceipt({
  date,
  licenseCode,
  paymentMethod,
}: {
  date: Date;
  licenseCode: string | null;
  paymentMethod: PaymentMethod | null;
}) {
  return (
    <div className="license-receipt">
      <dl>
        <div>
          <dt>内容</dt>
          <dd>IT-Index プレミアム(月額)</dd>
        </div>
        <div>
          <dt>支払い日</dt>
          <dd>{formatBillingDate(date)}</dd>
        </div>
        <div>
          <dt>金額</dt>
          <dd>{MONTHLY_PRICE_LABEL}</dd>
        </div>
        <div>
          <dt>支払い方法(現在の登録)</dt>
          <dd>
            {paymentMethod !== null
              ? `${brandLabel(paymentMethod.brand) ?? 'カード'} •••• ${paymentMethod.last4}`
              : '登録なし'}
          </dd>
        </div>
        {licenseCode !== null && (
          <div>
            <dt>ライセンスコード</dt>
            <dd>
              <code className="license-code">{licenseCode}</code>
            </dd>
          </div>
        )}
      </dl>
      <p className="license-receipt-note">
        これは正式な領収書ではありません。モック決済のため、この支払いは実際には行われていません。
      </p>
    </div>
  );
}

const CANCEL_CONFIRM_TEXT = '解約する';

/**
 * 解約(設定画面の最下部。本人指定)。取り消せない操作のため、DataSection(オールクリア)と
 * 同じ「確認パネルを開く→確認文字列の完全一致」の二段構えにする——同じ画面で確認の作法を
 * 揃えるため、ここだけ別の流儀(confirm()等)を持ち込まない。
 *
 * 解約は即時反映で、サーバー側ではライセンス無効化と登録カード削除が同時に行われる
 * (POST /api/license/cancel)。ライセンスコードは再利用できず、再開は新規購入になる。
 */
function CancelLicenseSection({ token, onCanceled }: { token: string; onCanceled: () => void }) {
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
    if (confirmText !== CANCEL_CONFIRM_TEXT || busy) return;
    setBusy(true);
    setError(null);
    try {
      await cancelLicense(token);
      onCanceled();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'サーバーに接続できませんでした');
      setBusy(false);
    }
  }

  return (
    <section className="settings-section settings-section-danger">
      <h2>解約</h2>
      <p className="status-text">
        IT-Index プレミアム(月額¥300)を解約します。<strong>この操作は取り消せません。</strong>
      </p>
      {!expanded ? (
        <button type="button" className="btn-danger" onClick={() => setExpanded(true)}>
          解約する
        </button>
      ) : (
        <div className="factory-reset-confirm">
          <p className="status-text">解約すると、次のようになります。</p>
          <ul className="status-text cancel-effects">
            <li>端末間同期と、共有キーでのAIチャットが<strong>すぐに使えなくなります</strong></li>
            <li>登録中のカード情報が削除されます</li>
            <li>
              このライセンスコードは<strong>再利用できません</strong>
              (再開するには新しく購入し直す必要があります)
            </li>
            <li>この端末の用語・ノート・履歴は消えません</li>
          </ul>
          <p className="status-text">
            実行するには下の欄に「{CANCEL_CONFIRM_TEXT}」と入力してください。
          </p>
          <label htmlFor="settings-cancel-license-confirm">確認文字列</label>
          <input
            id="settings-cancel-license-confirm"
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={CANCEL_CONFIRM_TEXT}
            disabled={busy}
          />
          <div className="sync-api-key-actions">
            <button
              type="button"
              className="btn-danger"
              onClick={() => void handleExecute()}
              disabled={confirmText !== CANCEL_CONFIRM_TEXT || busy}
            >
              {busy ? '解約しています…' : '解約を実行する'}
            </button>
            <button type="button" className="btn-text" onClick={handleCancel} disabled={busy}>
              やめる
            </button>
          </div>
          {error && <p className="sync-error">解約に失敗しました: {error}</p>}
        </div>
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
  // 「何のための設定か」のヘルプ(#163)。ライセンスのヘルプ(#151)と同じ方式で見出し行に置く
  const [helpOpen, setHelpOpen] = useState(false);

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
      <div className="settings-heading-row">
        <h2>接続先サーバー</h2>
        <button type="button" className="btn-text" onClick={() => setHelpOpen(true)}>
          この設定について
        </button>
      </div>
      {helpOpen && <ServerHelpModal onClose={() => setHelpOpen(false)} />}
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
      <p className="status-text-small">
        ライセンスとお支払い方法はアカウントに紐づいているため消えません(ログインし直すと戻ります)。
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
