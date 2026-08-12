import type { ItIndexDB } from '../db';

/**
 * v2のこのアプリが使う保存先(localStorage/sessionStorage)は例外なく'it-index-v2'接頭辞の
 * キー名で統一されている(sync/tokenStore.ts・sync/apiKeyStore.ts・sync/serverConfig.ts・
 * lib/theme.ts・lib/onboarding.ts・screenPersistence.ts)。個別キー名を書き並べると追加時に
 * 忘れるため、接頭辞一致で一括削除する。
 */
const APP_KEY_PREFIX = 'it-index-v2';

function clearStorageByPrefix(storage: Storage): void {
  for (const key of Object.keys(storage)) {
    if (key.startsWith(APP_KEY_PREFIX)) storage.removeItem(key);
  }
}

/**
 * 「オールクリア」(設定タブ・データ)。用語・ノート・履歴・チャット・APIキー・トークン・
 * 接続先サーバー設定・テーマ・オンボーディング既読状態まで含め、初回起動時と同じ状態に戻す
 * (移植元: ../../../src/factoryReset.ts。v1はAndroid keystoreの言及があったがv2には
 * 端末内暗号化保管が無いため対象外)。
 *
 * 実行後は呼び出し側で必ずwindow.location.reload()すること(このアプリの状態は全て
 * useState初期値かIndexedDB/localStorageから読み直す設計のため、リロードしないと
 * 画面上の見た目だけ古い状態が残る)。
 */
export async function resetAllData(db: ItIndexDB): Promise<void> {
  await db.delete();
  clearStorageByPrefix(localStorage);
  clearStorageByPrefix(sessionStorage);
}
