/**
 * 利用者が持ち込むAIプロバイダの資格情報(APIキー+プロバイダ+モデル名+検証済みフラグ)の
 * 端末内保存(BYOK。docs/v2/architecture.md §5「2つのキー経路」)。
 * sync/tokenStore.ts と同じ流儀で localStorage にキー名固定で置く。
 *
 * 平文で保存する: v1の端末内暗号化(WebAuthn PRF→safeStorage/Keystore)は端末環境依存で
 * 失敗しやすく断念した経緯があるため再現しない(要件定義書§1・§4.3)。代わりに
 * architecture.md §6 の第1層「漏れても被害が有限」——プロバイダ側の支出上限設定を
 * 利用者へ案内する——で被害を有限化する。
 *
 * 「検証済み(verified)」は接続テストが成功したことを表す(設定画面の接続テストは
 * POST /api/ai/models——モデル一覧の取得が疎通確認を兼ねる。screens/ApiKeySection.tsx)。
 * チャットで使うのは検証済みの資格情報だけで(getVerifiedCredential)、未検証のものは
 * 使わずサーバー側キー+回数上限の通常経路に落ちる。動作保証はしないが、
 * 「接続テストが通ったキーなら使える」という建て付けを、この1つのフラグで表現する。
 *
 * この値はサーバーに保存されない(リクエストのたびに転送し、サーバーは上流呼び出しに
 * 使うだけで保存もログ出力もしない。v2\server\src\ai.ts)。同期対象にも含めない。
 */
export type AiProvider = 'openai' | 'anthropic';

export interface AiCredential {
  key: string;
  provider: AiProvider;
  /** 未指定(空)ならサーバー側のプロバイダごとの既定モデルを使う */
  model?: string;
  /**
   * 接続テスト(=モデル一覧取得。POST /api/ai/models)で取得できた、このキーで選べるモデルID。
   * 設定画面のモデル選択(リストボックス)の選択肢として保存する——毎回プロバイダへ問い合わせずに
   * モデルを変更できるようにするため。未取得(旧保存データ)はundefinedで、その場合は
   * 接続テストの再実行で一覧を取り直す。
   */
  models?: string[];
  /** 接続テストに成功して保存されたか */
  verified: boolean;
}

const CREDENTIAL_KEY = 'it-index-v2:ai-credential';
/**
 * PR #87の保存キー(OpenAIキーの平文1本)。プロバイダ・モデル・検証済みフラグを持つ形へ
 * 移行するため、読み出し時に一度だけ新形式へ移す(旧キーは削除する)。
 * 移行後の verified を true にする理由: 旧形式のキーは既にチャットで実際に使われていた
 * (=上流に通っていた)ものであり、falseにすると利用者に断りなく共有キー+回数上限の
 * 経路へ戻してしまう。移行時点のプロバイダはOpenAI固定(旧形式はOpenAI専用だった)。
 */
const LEGACY_OPENAI_KEY = 'it-index-v2:openai-key';

const VALID_PROVIDERS: readonly string[] = ['openai', 'anthropic'];

function normalizeOptional(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** 保存されたモデル一覧の読み取り。配列でない・文字列でない要素は捨てる(壊れた値で画面を壊さない) */
function normalizeModels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const models = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
  return models.length === 0 ? undefined : models;
}

function write(credential: AiCredential): void {
  localStorage.setItem(CREDENTIAL_KEY, JSON.stringify(credential));
}

function parseStored(raw: string): AiCredential | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // 壊れた値は「未設定」として扱う(黙って消さず、上書き保存で直せるようにする)
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { key, provider, model, models, verified } = parsed as Record<string, unknown>;
  const normalizedKey = normalizeOptional(key);
  if (normalizedKey === undefined) return null;
  if (typeof provider !== 'string' || !VALID_PROVIDERS.includes(provider)) return null;
  return {
    key: normalizedKey,
    provider: provider as AiProvider,
    model: normalizeOptional(model),
    models: normalizeModels(models),
    verified: verified === true,
  };
}

/** 旧形式(キー1本)が残っていれば新形式へ移す。移行は1度だけで、旧キーは削除する */
function migrateLegacyKey(): AiCredential | null {
  const legacy = normalizeOptional(localStorage.getItem(LEGACY_OPENAI_KEY));
  localStorage.removeItem(LEGACY_OPENAI_KEY);
  if (legacy === undefined) return null;
  const migrated: AiCredential = { key: legacy, provider: 'openai', verified: true };
  write(migrated);
  return migrated;
}

/** 保存済みの資格情報(未検証も含む)。設定画面の状態表示はこちらを使う */
export function getAiCredential(): AiCredential | null {
  const raw = localStorage.getItem(CREDENTIAL_KEY);
  if (raw === null) return migrateLegacyKey();
  // 新形式が既にあるなら旧キーは不要(両方ある状態を残さない)
  localStorage.removeItem(LEGACY_OPENAI_KEY);
  return parseStored(raw);
}

/** チャット送信に使う資格情報。接続テストに通ったものだけを返す */
export function getVerifiedCredential(): AiCredential | null {
  const credential = getAiCredential();
  return credential !== null && credential.verified ? credential : null;
}

/**
 * 接続テストに成功した資格情報を保存する。**キーの保存はこの関数だけが行う**
 * (=テストを通っていないキーは保存されない)。
 */
export function saveVerifiedCredential(input: {
  key: string;
  provider: AiProvider;
  model?: string;
  models?: string[];
}): void {
  const key = input.key.trim();
  if (key === '') {
    clearAiCredential();
    return;
  }
  write({
    key,
    provider: input.provider,
    model: normalizeOptional(input.model),
    models: normalizeModels(input.models),
    verified: true,
  });
}

/**
 * 保存済みの資格情報のモデルだけを差し替える(設定画面のモデル選択の即時保存)。
 * キー・プロバイダ・検証済みフラグ・モデル一覧はそのまま——選び直したモデルは、既に接続テストに
 * 通っている同じキーで使う値なので、再テストを求めずに切り替えられるようにする(v1
 * SettingsModal.handleChangeModelと同じ扱い)。空文字はundefined(サーバー側の既定モデル)にする。
 * 資格情報が無い場合は何もしない(この関数でキーを作ることはない)。
 */
export function updateCredentialModel(model: string): AiCredential | null {
  const credential = getAiCredential();
  if (credential === null) return null;
  const updated: AiCredential = { ...credential, model: normalizeOptional(model) };
  write(updated);
  return updated;
}

/**
 * 一覧から最初に選ばせるモデルを決める(依頼者指定の既定)。
 * - OpenAI: `gpt-5.6-luna` があればそれ。無ければ一覧の先頭
 * - Anthropic: idに`haiku`を含む最初のもの(一覧はAPI順=新しい順なので、最も新しいHaiku)。
 *   無ければ一覧の先頭
 * 一覧が空の場合はundefined(呼び出し側はモデル名の直接入力にフォールバックする)。
 */
export const DEFAULT_OPENAI_MODEL = 'gpt-5.6-luna';

export function pickDefaultModel(provider: AiProvider, models: string[]): string | undefined {
  if (models.length === 0) return undefined;
  if (provider === 'openai') {
    return models.find((model) => model === DEFAULT_OPENAI_MODEL) ?? models[0];
  }
  return models.find((model) => model.includes('haiku')) ?? models[0];
}

/**
 * 上流がキーを拒否した場合(user_api_key_invalid)に検証済みフラグを解除する。
 * キー自体は消さない——設定画面で「無効になっている」ことを示し、直して再テストできるようにする。
 */
export function markCredentialUnverified(): void {
  const credential = getAiCredential();
  if (credential === null || !credential.verified) return;
  write({ ...credential, verified: false });
}

export function clearAiCredential(): void {
  localStorage.removeItem(CREDENTIAL_KEY);
  localStorage.removeItem(LEGACY_OPENAI_KEY);
}

/**
 * 状態表示用。キー本体は再表示せず、先頭数文字だけを見せる
 * (「設定済みだが、どのキーか」を利用者が見分けられる最小限)。
 */
export function maskApiKey(key: string): string {
  const head = key.slice(0, 6);
  return `${head}…`;
}

/** プロバイダの表示名(UIとメッセージで同じ語を使う) */
export function providerLabel(provider: AiProvider): string {
  return provider === 'openai' ? 'OpenAI' : 'Anthropic';
}
