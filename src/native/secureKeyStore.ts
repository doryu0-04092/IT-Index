import { registerPlugin } from '@capacitor/core';

/**
 * ネイティブプラグイン `SecureKeyStore` のTypeScript契約（Android版）。
 *
 * PC版はWebAuthnのパスキー（PRF拡張）でAPIキーを暗号化するが、Android実機では
 * パスキーが未設定のことが多く保存機能が使えなかった（ユーザー指摘）。代わりにAndroid
 * Keystoreに鍵を持たせ、端末標準のロック解除（指紋・顔・PIN・パターンいずれか）で
 * ゲートする。`src/keystore/androidSecureApiKeyStore.ts` が既存の `ApiKeyStore`
 * インターフェースの実装としてこれを使う。
 *
 * 実装は android/app/src/main/java/com/itindex/app/security/SecureKeyStorePlugin.java を参照。
 */
export interface SecureKeyStorePlugin {
  /**
   * この端末でKeystore保存が使えるか（ロック画面が未設定だと使えない）。
   * 使えない場合、理由を日本語で返す。
   */
  isAvailable(): Promise<{ available: boolean; reason?: string }>;

  /**
   * 平文を暗号化する。端末のロック解除（生体認証/PIN等）を求めるダイアログが出る。
   * ivはBase64文字列（呼び出し側はdecryptに渡す時に必要）。
   * ユーザーがダイアログをキャンセルした場合は reject する。
   */
  encrypt(options: { plaintext: string }): Promise<{ ciphertext: string; iv: string }>;

  /** 保存済みの暗号文を復号する。同じく端末のロック解除を求める。 */
  decrypt(options: { ciphertext: string; iv: string }): Promise<{ plaintext: string }>;

  /** Keystoreの鍵を削除する（保存解除時に呼ぶ）。鍵が無くても失敗しない。 */
  clear(): Promise<void>;
}

export const SecureKeyStore = registerPlugin<SecureKeyStorePlugin>('SecureKeyStore');
