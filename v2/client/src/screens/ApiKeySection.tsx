import { useState } from 'react';
import { ApiRequestError, fetchAiModels } from '../sync/apiClient';
import {
  clearAiCredential,
  getAiCredential,
  maskApiKey,
  pickDefaultModel,
  providerLabel,
  saveVerifiedCredential,
  updateCredentialModel,
  type AiProvider,
} from '../sync/apiKeyStore';

/**
 * 利用者が自分のAPIキーを持ち込む設定(BYOK。docs/v2/architecture.md §5)。
 *
 * v1のApiKeyPrompt.tsxと同じ2段階の導線にしてある:
 * ① プロバイダとAPIキーを入力し「接続テスト」→ POST /api/ai/models でそのキーで使えるモデルの
 *    一覧を取得する。**この一覧取得自体がキーの疎通確認を兼ねる**(無効ならここで分かる)ため、
 *    接続テスト専用のPOST /api/ai/testはサーバーに残しつつ、この画面からは呼ばない。
 * ② 取得できた一覧からモデルを選ぶ(自由入力だと誤ったモデル名を打ち込めてしまうため
 *    リストボックスにする。一覧が0件だった場合のみ直接入力にフォールバックする)。
 *
 * 保存の唯一の入口は接続テストの成功(handleTest)。テストに通っていないキーは保存されず、
 * チャットにも使われない(sync/apiKeyStore.ts の verified)。「動作保証はしないが、
 * 接続テストが通ったキーなら使える」という建て付けをUIの導線として固定する。
 * モデル一覧も資格情報と一緒に保存するため、保存後はプロバイダへ問い合わせ直さずに
 * いつでもモデルを変更できる(変更は選んだ時点で即座に永続化する)。
 */
export default function ApiKeySection({ token }: { token: string }) {
  // localStorageの読み取りはこの画面がマウントされた時点の状態でよい(保存・削除は
  // すべてこのコンポーネント内の操作なので、stateを唯一の表示源にできる)。
  const [saved, setSaved] = useState(() => getAiCredential());
  // 初期値は保存済みの設定に合わせる(2回目以降のレンダーでは初期化式は評価されない)。
  const [provider, setProvider] = useState<AiProvider>(saved?.provider ?? 'openai');
  const [keyDraft, setKeyDraft] = useState('');
  // 一覧が0件だった場合のフォールバック入力。保存済みのモデル名を初期値にする。
  const [manualModel, setManualModel] = useState(saved?.model ?? '');
  // 「今回の接続テストでは一覧が0件だった」ことだけを表す。models未取得の旧保存データ
  // (再テストで一覧を取れる)と区別するために持つ。
  const [modelListEmpty, setModelListEmpty] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleTest() {
    const key = keyDraft.trim();
    if (key === '' || testing) return;
    setTesting(true);
    setMessage(null);
    setError(null);
    try {
      const result = await fetchAiModels(token, { key, provider });
      const model = pickDefaultModel(provider, result.models);
      // 成功したときに初めて保存する(失敗したキーは端末にも残さない)
      saveVerifiedCredential({ key, provider, model, models: result.models });
      setSaved(getAiCredential());
      setKeyDraft(''); // 入力欄にキーを残さない(画面に平文が出続けないようにする)
      setManualModel(model ?? '');
      setModelListEmpty(result.models.length === 0);
      setMessage(
        result.models.length > 0
          ? `接続を確認いたしました(${providerLabel(result.provider)})。設定を保存いたしました。お使いになるモデルを下の一覧からお選びください。`
          : `接続を確認いたしました(${providerLabel(result.provider)})。設定を保存いたしました。モデルの一覧を取得できませんでしたので、お使いになるモデル名をご入力ください。`,
      );
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.message
          : 'サーバーに接続できませんでした。しばらく経ってから、もう一度お試しください。',
      );
    } finally {
      setTesting(false);
    }
  }

  /** 一覧からのモデル変更。保存済みのキーはそのままなので、再テストは求めずに即時保存する */
  function handleSelectModel(model: string) {
    const updated = updateCredentialModel(model);
    setSaved(updated);
    setManualModel(model);
    setError(null);
    setMessage(`モデルを ${model} に変更し、保存いたしました。`);
  }

  /** 一覧を取得できなかった場合の直接入力。入力のたびに保存する(空欄は既定のモデルの指定になる) */
  function handleManualModelChange(model: string) {
    setManualModel(model);
    setSaved(updateCredentialModel(model));
  }

  function handleClear() {
    clearAiCredential();
    setSaved(null);
    setKeyDraft('');
    setManualModel('');
    setModelListEmpty(false);
    setMessage(
      'お客様のAPIキーを削除いたしました。以降は共有のキー(1日あたりの回数上限があります)で実行されます。',
    );
    setError(null);
  }

  const statusText = (() => {
    if (saved === null) return '現在の状態: 未設定です(共有のキーを使用します)';
    const base = `${providerLabel(saved.provider)}・${maskApiKey(saved.key)}${saved.model ? `・${saved.model}` : '・既定のモデル'}`;
    return saved.verified
      ? `現在の状態: 検証済みです(${base})`
      : `現在の状態: 未検証です(${base})。接続テストに成功するまで、チャットには使用されません`;
  })();

  // 保存済みのモデルが一覧に無い場合は先頭に足して表示する(利用者が現在の設定を見失わないため。
  // v1 SettingsModal.tsxと同じ扱い——一覧はプロバイダ側の都合で入れ替わりうる)。
  const modelOptions = (() => {
    const models = saved?.models;
    if (models === undefined) return null;
    const current = saved?.model;
    if (current === undefined || models.includes(current)) return models;
    return [current, ...models];
  })();

  return (
    <div className="sync-api-key">
      <p className="status-text">
        お客様ご自身のAPIキーをご登録いただくと、回数の上限なくAIチャットをご利用いただけます。
        キーはこの端末にのみ保存され、サーバーには保存されません。ご登録がない場合は、
        共有のキー(1日あたりの回数上限があります)で動作します。
      </p>
      <p className="status-text">
        <strong>
          各プロバイダのコンソールで、支出上限(Monthly budget)を必ずご設定ください。
        </strong>
        キーが漏れた場合の被害を、その上限までに抑えるための備えとなります。
      </p>
      <p className="status-text">
        OpenAI以外のプロバイダにつきましては、実動作の確認ができておりません。接続テストに成功すれば
        ご利用いただけますが、応答品質は保証いたしかねます。
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
        placeholder={saved === null ? '' : '(保存済みです。変更される場合のみご入力ください)'}
        onChange={(e) => setKeyDraft(e.target.value)}
      />
      <p className="status-text">
        接続テストでは、ご入力いただいたキーでお使いになれるモデルの一覧を取得いたします。
        成功した場合のみ、この端末に保存いたします。
      </p>

      <div className="sync-api-key-actions">
        <button
          type="button"
          className="btn-primary"
          onClick={() => void handleTest()}
          disabled={testing || keyDraft.trim() === ''}
        >
          {testing ? '接続を確認しています…' : '接続テスト'}
        </button>
        <button type="button" className="btn-danger" onClick={handleClear} disabled={saved === null}>
          削除する
        </button>
      </div>

      {saved !== null && modelOptions !== null && (
        <>
          <label htmlFor="sync-api-model-select">モデル</label>
          <select
            id="sync-api-model-select"
            value={saved.model ?? modelOptions[0]}
            onChange={(e) => handleSelectModel(e.target.value)}
          >
            {modelOptions.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
          <p className="status-text">
            保存済みの一覧から、いつでもご変更いただけます。お選びいただいた時点で保存いたします。
          </p>
        </>
      )}

      {saved !== null && modelOptions === null && modelListEmpty && (
        <>
          <label htmlFor="sync-api-model-input">モデル名(一覧を取得できませんでしたので直接ご入力ください)</label>
          <input
            id="sync-api-model-input"
            type="text"
            autoComplete="off"
            value={manualModel}
            onChange={(e) => handleManualModelChange(e.target.value)}
          />
          <p className="status-text">空欄の場合は、プロバイダごとの既定のモデルを使用いたします。</p>
        </>
      )}

      {saved !== null && modelOptions === null && !modelListEmpty && (
        <p className="status-text">
          接続テストを再度実行いただきますと、お選びいただけるモデルの一覧を取得いたします。
        </p>
      )}

      {message && <p className="status-text">{message}</p>}
      {error && <p className="sync-error">{error}</p>}
    </div>
  );
}
