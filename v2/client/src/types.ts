/**
 * v2クライアント端末内のみで使う型。@it-index/shared(変更禁止)には置かない
 * ——sharedは端末・サーバー間で共有する型・純関数だけを持つ(docs/v2/architecture.md §8)。
 */

/** 同期対象外。APIキーは含めない(v2はPhase 1の間、端末内キー保管自体を持たない) */
export interface SettingsRecord {
  key: 'singleton';
  deviceId: string;
  seedVersion: string | null;
}
