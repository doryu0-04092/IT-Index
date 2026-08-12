import { useState } from 'react';
import { ApiRequestError, testAiConnection } from '../sync/apiClient';
import {
  clearAiCredential,
  getAiCredential,
  maskApiKey,
  providerLabel,
  saveVerifiedCredential,
  type AiProvider,
} from '../sync/apiKeyStore';

/**
 * 利用者が自分のAPIキーを持ち込む設定(BYOK。docs/v2/architecture.md §5)。
 * 元はSyncScreen.tsxに置いていたが、設定タブ新設(PR)に伴い「AI設定」セクションとして
 * ここへ移設した(挙動は変更していない)。
 *
 * 保存の唯一の入口は接続テストの成功(handleTest)。テストに通っていないキーは保存されず、
 * チャットにも使われない(sync/apiKeyStore.ts の verified)。「動作保証はしないが、
 * 接続テストが通ったキーなら使える」という建て付けをUIの導線として固定する。
 */
export default function ApiKeySection({ token }: { token: string }) {
  // localStorageの読み取りはこの画面がマウントされた時点の状態でよい(保存・削除は
  // すべてこのコンポーネント内の操作なので、stateを唯一の表示源にできる)。
  const [saved, setSaved] = useState(() => getAiCredential());
  // 初期値は保存済みの設定に合わせる(2回目以降のレンダーでは初期化式は評価されない)。
  const [provider, setProvider] = useState<AiProvider>(saved?.provider ?? 'openai');
  const [keyDraft, setKeyDraft] = useState('');
  const [modelDraft, setModelDraft] = useState(saved?.model ?? '');
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleTest() {
    const key = keyDraft.trim();
    if (key === '' || testing) return;
    setTesting(true);
    setMessage(null);
    setError(null);
    const model = modelDraft.trim() === '' ? undefined : modelDraft.trim();
    try {
      const result = await testAiConnection(token, { key, provider, model });
      // 成功したときに初めて保存する(失敗したキーは端末にも残さない)
      saveVerifiedCredential({ key, provider, model });
      setSaved(getAiCredential());
      setKeyDraft(''); // 入力欄にキーを残さない(画面に平文が出続けないようにする)
      setMessage(`接続できました(${providerLabel(result.provider)}・${result.model})。保存しました。`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'サーバーに接続できませんでした');
    } finally {
      setTesting(false);
    }
  }

  function handleClear() {
    clearAiCredential();
    setSaved(null);
    setKeyDraft('');
    setModelDraft('');
    setMessage('自分のAPIキーを削除しました。以降は共有のキー(回数上限あり)で実行されます。');
    setError(null);
  }

  const statusText = (() => {
    if (saved === null) return '現在の状態: 未設定(共有のキーを使用)';
    const base = `${providerLabel(saved.provider)}・${maskApiKey(saved.key)}${saved.model ? `・${saved.model}` : '・既定モデル'}`;
    return saved.verified
      ? `現在の状態: 検証済み(${base})`
      : `現在の状態: 未検証(${base})。接続テストに通るまでチャットには使いません`;
  })();

  return (
    <div className="sync-api-key">
      <p className="status-text">
        自分のキーを使うと回数上限なしでAIチャットを利用できます。キーはこの端末にのみ保存され、
        サーバーには保存されません。未設定の場合は共有のキー(1日あたりの回数上限あり)で動きます。
      </p>
      <p className="status-text">
        <strong>
          必ず各プロバイダのコンソールで支出上限(Monthly budget)を設定してください。
        </strong>
        キーが漏れた場合の被害を、その上限までに抑えるための備えです。
      </p>
      <p className="status-text">
        OpenAI以外のプロバイダは実動作の確認をしていません。接続テストが通れば利用できますが、
        応答品質は保証しません。
      </p>

      <p className="status-text" data-testid="api-key-status">
        {statusText}
      </p>

      <label htmlFor="sync-api-provider">プロバイダ</label>
      <select
        id="sync-api-provider"
        value={provider}
        onChange={(e) => setProvider(e.target.value as AiProvider)}
      >
        <option value="openai">OpenAI</option>
        <option value="anthropic">Anthropic</option>
      </select>

      <label htmlFor="sync-api-key-input">APIキー</label>
      <input
        id="sync-api-key-input"
        type="password"
        autoComplete="off"
        value={keyDraft}
        placeholder={saved === null ? '' : '(保存済み。変更する場合のみ入力)'}
        onChange={(e) => setKeyDraft(e.target.value)}
      />

      <label htmlFor="sync-api-model-input">モデル名(任意)</label>
      <input
        id="sync-api-model-input"
        type="text"
        autoComplete="off"
        value={modelDraft}
        onChange={(e) => setModelDraft(e.target.value)}
      />
      <p className="status-text">空欄ならプロバイダごとの既定モデルを使います。</p>

      <div className="sync-api-key-actions">
        <button
          type="button"
          className="btn-primary"
          onClick={() => void handleTest()}
          disabled={testing || keyDraft.trim() === ''}
        >
          {testing ? '接続を確認しています…' : '接続テスト'}
        </button>
        <button type="button" className="btn-secondary" onClick={handleClear} disabled={saved === null}>
          削除する
        </button>
      </div>
      {message && <p className="status-text">{message}</p>}
      {error && <p className="sync-error">{error}</p>}
    </div>
  );
}
