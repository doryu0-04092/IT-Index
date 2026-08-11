/**
 * 利用者が持ち込むOpenAI APIキーの端末内保存(BYOK。docs/v2/architecture.md §5「2つのキー経路」)。
 * sync/tokenStore.ts と同じ流儀で localStorage にキー名固定で置く。
 *
 * 平文で保存する: v1の端末内暗号化(WebAuthn PRF→safeStorage/Keystore)は端末環境依存で
 * 失敗しやすく断念した経緯があるため再現しない(要件定義書§1・§4.3)。代わりに
 * architecture.md §6 の第1層「漏れても被害が有限」——OpenAI側の支出上限(Monthly budget)
 * 設定を利用者へ案内する——で被害を有限化する。
 *
 * この値はサーバーに保存されない(リクエストのたびに転送し、サーバーは上流呼び出しに
 * 使うだけで保存もログ出力もしない。v2\server\src\ai.ts)。同期対象にも含めない。
 */
const API_KEY_KEY = 'it-index-v2:openai-key';

/** 空文字・空白のみは「未設定」として扱う(サーバー側も同じ扱いにしてある) */
export function getApiKey(): string | null {
  const raw = localStorage.getItem(API_KEY_KEY);
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

export function setApiKey(key: string): void {
  const trimmed = key.trim();
  if (trimmed === '') {
    clearApiKey();
    return;
  }
  localStorage.setItem(API_KEY_KEY, trimmed);
}

export function clearApiKey(): void {
  localStorage.removeItem(API_KEY_KEY);
}

/**
 * 状態表示用。キー本体は再表示せず、先頭数文字だけを見せる
 * (「設定済みだが、どのキーか」を利用者が見分けられる最小限)。
 */
export function maskApiKey(key: string): string {
  const head = key.slice(0, 6);
  return `${head}…`;
}
