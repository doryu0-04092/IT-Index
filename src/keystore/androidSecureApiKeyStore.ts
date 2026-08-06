import type { AiCredential } from './apiKeyStore';
import { setSessionCredential, type ApiKeyStore } from './apiKeyStore';
import type { KeyStoreRepository } from '../repositories/keyStore';
import { SecureKeyStore } from '../native/secureKeyStore';

/**
 * Android版の `ApiKeyStore` 実装。PC版（`createApiKeyStore`、WebAuthnのパスキー/PRF拡張）とは
 * 違い、Android Keystore＋端末標準のロック解除（生体認証/PIN/パターン）で暗号化する
 * （`src/native/secureKeyStore.ts`、ユーザー指摘対応）。`ApiKeyStore` インターフェース自体は
 * PC版と共通のため、呼び出し側（SettingsModal・ApiKeyPrompt）は一切変更していない。
 *
 * `KeyStoreRecord`（`src/types.ts`）の`ciphertext`/`iv`はPC版のWeb Crypto API出力に合わせて
 * ArrayBuffer/Uint8Array型だが、ネイティブプラグインとのやり取りはBase64文字列（Capacitorの
 * ブリッジはJSON互換の値しか運べない）。ここで相互変換する。
 * `credentialId` フィールドは元々WebAuthnのpasskey ID用だが、`KeyStoreRepository` の
 * スキーマを流用するため固定のダミー値を入れておく（Android版では使わない）。
 */
const ANDROID_CREDENTIAL_ID = new TextEncoder().encode('android-keystore').buffer;

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function createAndroidSecureApiKeyStore(keyStoreRepo: KeyStoreRepository): ApiKeyStore {
  return {
    isPersistenceAvailable() {
      // 実際に使えるかは生体認証ダイアログを開くまで確定できないが、ボタンを出すかどうかの
      // 判定には十分（PC版のwebauthn.isAvailable()と同じ位置づけ）。
      return true;
    },

    async hasPersistedCredential() {
      const record = await keyStoreRepo.get();
      return record !== undefined;
    },

    async enablePersistence(credential: AiCredential) {
      const availability = await SecureKeyStore.isAvailable();
      if (!availability.available) {
        throw new Error(availability.reason ?? 'この端末では保存できません');
      }

      const { ciphertext, iv } = await SecureKeyStore.encrypt({ plaintext: credential.apiKey });
      await keyStoreRepo.put({
        provider: credential.provider,
        model: credential.model,
        credentialId: ANDROID_CREDENTIAL_ID,
        ciphertext: base64ToBytes(ciphertext).buffer,
        iv: base64ToBytes(iv),
      });
      setSessionCredential(credential);
    },

    async tryRestore() {
      const record = await keyStoreRepo.get();
      if (!record) return false;

      const { plaintext } = await SecureKeyStore.decrypt({
        ciphertext: bytesToBase64(record.ciphertext),
        iv: bytesToBase64(record.iv),
      });
      setSessionCredential({ provider: record.provider, model: record.model, apiKey: plaintext });
      return true;
    },

    async disablePersistence() {
      await keyStoreRepo.clear();
      await SecureKeyStore.clear();
    },

    async updatePersistedModel(model) {
      const record = await keyStoreRepo.get();
      if (!record) return; // 保存していない（セッションのみ）
      const { key: _key, ...rest } = record;
      await keyStoreRepo.put({ ...rest, model });
    },
  };
}
