import type { AiProvider } from '../ai/providers/types';

export interface AiCredential {
  provider: AiProvider;
  apiKey: string;
  model: string;
}

/**
 * セッション中のみのメモリ保持（docs/requirements.md §5.6 層3・既定の状態）。
 * モジュールスコープの変数なのでタブを閉じれば消える。
 * プロバイダ・モデルもキーとセットで持つ（プロバイダごとにAPIキーの形式・呼び出し先が違うため）。
 */
let sessionCredential: AiCredential | null = null;

export function setSessionCredential(credential: AiCredential): void {
  sessionCredential = credential;
}

export function getSessionCredential(): AiCredential | null {
  return sessionCredential;
}

export function clearSessionCredential(): void {
  sessionCredential = null;
}

/**
 * PC版（`electronSafeStorageApiKeyStore.ts`）・Android版（`androidSecureApiKeyStore.ts`）
 * 共通のインターフェース。プラットフォームごとに保存の裏付け（safeStorage / Android Keystore）が
 * 異なるだけで、呼び出し側（`ApiKeyPrompt.tsx`・`SettingsModal.tsx`）はこれだけを見る。
 */
export interface ApiKeyStore {
  /** この端末で保存機能自体が使える環境か。ボタンを出すかどうかの判定に使う */
  isPersistenceAvailable(): boolean;
  /**
   * 保存済みの資格情報が存在するか（復号はしない。存在確認だけなので認証を要さない）。
   * 起動直後に「保存内容を使う」ボタンを出すかどうかの判定に使う。
   */
  hasPersistedCredential(): Promise<boolean>;
  /** 明示的なオプトイン。暗号化保存し、同時にセッションにも載せる */
  enablePersistence(credential: AiCredential): Promise<void>;
  /** 保存済みなら復号してセッションに載せる。無ければ何もせず false。 */
  tryRestore(): Promise<boolean>;
  disablePersistence(): Promise<void>;
  /**
   * 保存済みならモデル名だけ書き換える（APIキー自体は変わらないため再暗号化は不要）。
   * 保存していない（セッションのみ）場合は何もしない——呼び出し側がセッション側の
   * `setSessionCredential` を別途呼ぶ。
   */
  updatePersistedModel(model: string): Promise<void>;
}
