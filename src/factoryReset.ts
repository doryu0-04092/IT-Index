import { db } from './db';
import { clearPersistedScreen } from './screenPersistence';

/**
 * 「オールクリア」（設定画面）。語・ノート・履歴だけでなく、APIキー保存状態・
 * テーマ設定・オンボーディング/機能ヒントの既読状態まで含め、初回起動時と同じ状態に戻す。
 *
 * 実行後は呼び出し側で必ず `window.location.reload()` すること（このアプリの状態は全て
 * useState初期値かIndexedDB/localStorageから読み直す設計のため、リロードしないと
 * 画面上の見た目だけ古い状態が残る）。
 *
 * 注意: ここで消えるのは「保存済みAPIキーの暗号化データ」（IndexedDBの行）のみ。
 * Android版はAndroid Keystore側の鍵自体はここでは削除されない（アプリ内に残る参照が
 * 無くなるだけで、再度保存すれば新しい鍵で上書きされる。実害は無い）。
 */
export async function factoryReset(): Promise<void> {
  await db.delete();

  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('it-index-')) localStorage.removeItem(key);
  }

  // リロード時の画面復元（#39）は sessionStorage に持っている。これを消さないと、
  // 初期化直後のリロードで「設定」「連携」など直前の画面に復帰してしまう。
  clearPersistedScreen();
}
