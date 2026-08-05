import type { AiCredential } from './apiKeyStore';
import { setSessionCredential, type ApiKeyStore } from './apiKeyStore';
import type { KeyStoreRepository } from '../repositories/keyStore';

/**
 * PC版(Electron)の `ApiKeyStore` 実装。以前はWebAuthnのパスキー/PRF拡張で暗号化していたが、
 * Windows Hello等プラットフォーム認証器の設定状況に依存して失敗しやすく、保存自体ができない
 * 環境があった（ユーザー指摘）。代わりにElectron組み込みの safeStorage（OS標準の暗号化。
 * Windowsは資格情報保護機能）を使う（`electron/main.ts`のIPCハンドラ経由）。
 * Android版（`androidSecureApiKeyStore.ts`、Android Keystore＋端末ロック解除）と同じ考え方。
 * `ApiKeyStore` インターフェース自体は共通のため、呼び出し側は一切変更していない。
 *
 * `KeyStoreRecord`（`src/types.ts`）の`credentialId`/`iv`は元々WebAuthnのpasskey ID・AES-GCMの
 * IV用だが、`KeyStoreRepository`のスキーマを流用するためダミー値を入れておく
 * （Android版が`ANDROID_CREDENTIAL_ID`で行っているのと同じ扱い）。safeStorageの暗号文は
 * それ自体で復号に必要な情報を含んでいるため、別途IVを保持する必要が無い。
 */
const ELECTRON_CREDENTIAL_ID = new TextEncoder().encode('electron-safe-storage').buffer;
const EMPTY_IV = new Uint8Array(0);

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

export function createElectronSafeStorageApiKeyStore(keyStoreRepo: KeyStoreRepository): ApiKeyStore {
  return {
    isPersistenceAvailable() {
      // 実際に使えるかはIPC（非同期）でしか分からないが、ボタンを出すかどうかの判定には
      // 十分（Android版のisPersistenceAvailable()と同じ位置づけ）。
      return !!window.desktop;
    },

    async hasPersistedCredential() {
      const record = await keyStoreRepo.get();
      return record !== undefined;
    },

    async enablePersistence(credential: AiCredential) {
      if (!window.desktop) throw new Error('この機能はデスクトップ版でのみ使えます');

      const available = await window.desktop.keystoreIsAvailable();
      if (!available) throw new Error('この端末では保存機能が使えません（OSの暗号化機能が利用できません）');

      const ciphertext = await window.desktop.keystoreEncrypt(credential.apiKey);
      await keyStoreRepo.put({
        provider: credential.provider,
        model: credential.model,
        credentialId: ELECTRON_CREDENTIAL_ID,
        ciphertext: base64ToBytes(ciphertext).buffer,
        iv: EMPTY_IV,
      });
      setSessionCredential(credential);
    },

    async tryRestore() {
      if (!window.desktop) return false;
      const record = await keyStoreRepo.get();
      if (!record) return false;

      const plaintext = await window.desktop.keystoreDecrypt(bytesToBase64(record.ciphertext));
      setSessionCredential({ provider: record.provider, model: record.model, apiKey: plaintext });
      return true;
    },

    async disablePersistence() {
      await keyStoreRepo.clear();
    },
  };
}
